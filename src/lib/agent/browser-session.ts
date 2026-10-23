"use client";

import { create } from "zustand";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore, runAgentCanvasEdit } from "@/store/design-store";
import { liveDesignIdInThisTab } from "@/store/live-edit-gate";
import { createNewProject } from "@/examples";
import { serializeFactoryProject } from "@/lib/import-export/factory-json";
import { encodePlanCode } from "@/lib/import-export/plan-code";
import { arrangeInWorker } from "@/lib/arrange-solve";
import { readBoardGeometry } from "@/components/flow/board-score";
import { z } from "zod";
import {
  AgentError,
  AGENT_PROTOCOL,
  browserCommandSchema,
  constraintsSchema,
  actionsSchema,
  errorResult,
  type BrowserCommand,
  type DatasetIdentity,
} from "./protocol";
import { PlannerApi, datasetIdentity } from "./data-client";
import { applyAgentActions, designView, evaluateDesign, machineOptions } from "./editor";
import {
  RELAY_PAIRING_PREFIX,
  RELAY_PROTOCOL,
  relayCodeSchema,
  relayGrantSchema,
  relaySocketUrl,
  type RelayGrant,
} from "./relay-protocol";

export const useAgentConnection = create<{
  state: "disconnected" | "connecting" | "connected" | "error";
  message?: string;
  designId?: string;
  allowCreate?: boolean;
}>(() => ({ state: "disconnected" }));
const sessionId = typeof crypto !== "undefined" ? crypto.randomUUID() : "server";
let revision = 0;
let socket: WebSocket | undefined;
let stopTracking: (() => void) | undefined;
let connectEpoch = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
interface BrowserScope {
  grant: RelayGrant;
  designIds: Set<string>;
  token: string;
  creating: boolean;
}
let activeScope: BrowserScope | undefined;
let queue: Promise<unknown> = Promise.resolve();
const receipts = new Map<string, { serialized: string; result: unknown }>();
const MUTATIONS = new Set([
  "create_design",
  "open_design",
  "apply_design_actions",
  "arrange_design",
  "undo_design",
  "redo_design",
]);

function identity(): DatasetIdentity {
  const state = useFactoryStore.getState();
  const version = state.datasetManifest?.versions.find(
    (entry) => entry.id === state.dataset?.datasetVersionId,
  );
  if (!version || state.isDatasetLoading || state.isProjectImporting)
    throw new AgentError(
      "DATASET_NOT_READY",
      "Wait for the webpage's dataset and recipes to load.",
    );
  return datasetIdentity(version);
}

function status() {
  let dataset;
  try {
    dataset = identity();
  } catch {
    /* The status remains readable during initial loading. */
  }
  const state = useDesignStore.getState();
  return {
    sessionId,
    revision,
    designId: state.activeDesignId,
    dataset,
    readOnly:
      useFactoryStore.getState().isReadOnly ||
      useFactoryStore.getState().checklistMode ||
      !!liveDesignIdInThisTab() ||
      !!state.designs.find((entry) => entry.id === state.activeDesignId)?.cloud,
    saveState: state.saveState,
  };
}

function publishStatus() {
  if (activeScope?.creating) return;
  const id = useDesignStore.getState().activeDesignId;
  if (activeScope && id && !activeScope.designIds.has(id)) {
    disconnectAgent();
    useAgentConnection.setState({
      message: "Design changed. Pair this design before agent edits.",
    });
    return;
  }
  useAgentConnection.setState({ designId: useDesignStore.getState().activeDesignId });
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ t: "status", status: status() }));
}

export function disconnectAgent() {
  connectEpoch++;
  clearTimeout(reconnectTimer);
  const previousScope = activeScope;
  activeScope = undefined;
  if (previousScope)
    void fetch("/api/agent/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${previousScope.token}`,
      },
      body: JSON.stringify({ pairingId: previousScope.grant.pairingId }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  const closing = socket;
  socket = undefined;
  closing?.close();
  stopTracking?.();
  stopTracking = undefined;
  useAgentConnection.setState({ state: "disconnected", message: undefined });
}

export async function connectAgent(code: string, options: { allowCreate?: boolean } = {}) {
  disconnectAgent();
  const epoch = connectEpoch;
  if (code.trim().startsWith(RELAY_PAIRING_PREFIX)) {
    const config = relayCodeSchema.parse(
      JSON.parse(
        atob(code.trim().slice(RELAY_PAIRING_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")),
      ),
    );
    if (
      config.origin !== window.location.origin ||
      (window.location.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))
    )
      throw new AgentError(
        "ORIGIN_MISMATCH",
        "Open the exact HTTPS planner address used by the agent.",
      );
    if (status().readOnly)
      throw new AgentError(
        "READ_ONLY",
        "Choose an editable browser design. Cloud and live designs are not supported by this bridge.",
      );
    if (!status().designId && !options.allowCreate)
      throw new AgentError("PERMISSION_DENIED", "Open a design or allow new designs.");
    useAgentConnection.setState({ state: "connecting", message: undefined });
    const response = await fetch("/api/agent/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingId: config.pairingId,
        userCode: config.userCode,
        status: status(),
        allowCreate: options.allowCreate ?? false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) {
      useAgentConnection.setState({ state: "error" });
      throw new AgentError(
        result.error?.code ?? "PAIRING_REFUSED",
        result.error?.message ?? "Pairing refused.",
      );
    }
    const approved = z
      .object({ browserToken: z.string().min(32), grant: relayGrantSchema })
      .parse(result);
    if (epoch !== connectEpoch) {
      void fetch("/api/agent/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${approved.browserToken}`,
        },
        body: JSON.stringify({ pairingId: approved.grant.pairingId }),
      }).catch(() => undefined);
      return;
    }
    const scope: BrowserScope = {
      grant: approved.grant,
      designIds: new Set(approved.grant.designIds),
      token: approved.browserToken,
      creating: false,
    };
    activeScope = scope;
    openSocket(relaySocketUrl(config.origin), new PlannerApi(config.origin), scope);
    return;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))
    throw new AgentError("LOCAL_ONLY", "Connect from a local planner page.");
  const config = z
    .object({
      url: z.string(),
      token: z.string().min(32),
      apiBaseUrl: z.string(),
      v: z.literal(AGENT_PROTOCOL),
    })
    .strict()
    .parse(
      JSON.parse(
        atob(
          code
            .trim()
            .replace(/^gtnh-agent\./, "")
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        ),
      ),
    );
  const endpoint = new URL(config.url);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    config.apiBaseUrl !== window.location.origin
  )
    throw new AgentError(
      "ORIGIN_MISMATCH",
      "Open the exact planner address configured in the MCP server.",
    );
  const api = new PlannerApi(config.apiBaseUrl);
  openSocket(endpoint.href, api, undefined, config.token);
}

function openSocket(
  endpoint: string,
  api: PlannerApi,
  scope?: BrowserScope,
  localCredential?: string,
) {
  useAgentConnection.setState({ state: "connecting", message: undefined });
  const ws = new WebSocket(endpoint);
  socket = ws;
  ws.onopen = () =>
    ws.send(
      JSON.stringify(
        scope
          ? {
              t: "hello",
              v: RELAY_PROTOCOL,
              role: "browser",
              pairingId: scope.grant.pairingId,
              token: scope.token,
            }
          : {
              t: "hello",
              token: localCredential,
              browserId: sessionId,
              apiBaseUrl: window.location.origin,
              v: AGENT_PROTOCOL,
              status: status(),
            },
      ),
    );
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      ws.close(1008, "Invalid agent message");
      return;
    }
    if (message.t === "ready") {
      useAgentConnection.setState({
        state: "connected",
        allowCreate: scope?.grant.allowCreate ?? true,
      });
      stopTracking?.();
      const offFactory = useFactoryStore.subscribe((state, previous) => {
        if (state.project !== previous.project || state.dataset !== previous.dataset) {
          revision++;
          publishStatus();
        }
      });
      const offDesign = useDesignStore.subscribe((state, previous) => {
        if (state.activeDesignId !== previous.activeDesignId) {
          revision++;
          publishStatus();
        }
      });
      stopTracking = () => {
        offFactory();
        offDesign();
      };
      publishStatus();
    } else if (message.t === "command") {
      queue = queue
        .then(async () => {
          if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
          const command = browserCommandSchema.parse(message.command);
          const serialized = JSON.stringify(command);
          const receiptKey = `${scope?.grant.pairingId ?? localCredential}:${command.requestId}`;
          const old = receipts.get(receiptKey);
          let result;
          if (old)
            result =
              old.serialized === serialized
                ? old.result
                : {
                    ok: false,
                    error: {
                      code: "REQUEST_ID_REUSED",
                      message: "Use a new request id for different arguments.",
                    },
                  };
          else {
            try {
              result = {
                ok: true,
                value: await executeBrowserCommand(
                  command,
                  api,
                  () => socket === ws && ws.readyState === WebSocket.OPEN,
                  scope,
                ),
                status: status(),
              };
            } catch (error) {
              result = { ok: false, error: errorResult(error), status: status() };
            }
            receipts.set(receiptKey, { serialized, result });
            if (receipts.size > 1000) receipts.delete(receipts.keys().next().value!);
          }
          if (socket === ws && ws.readyState === WebSocket.OPEN) {
            const encoded = JSON.stringify({ t: "result", requestId: command.requestId, result });
            if (new TextEncoder().encode(encoded).byteLength > 3_900_000) {
              ws.send(
                JSON.stringify({
                  t: "result",
                  requestId: command.requestId,
                  result: {
                    ok: false,
                    error: {
                      code: "TOO_LARGE",
                      message:
                        "Use paginated planning detail or inspect selected entities; this full response exceeds the bridge limit.",
                    },
                    status: status(),
                  },
                }),
              );
            } else ws.send(encoded);
            publishStatus();
          }
        })
        .catch((error) => {
          useAgentConnection.setState({
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
  };
  ws.onerror = () => {
    if (socket === ws)
      useAgentConnection.setState({
        state: "error",
        message: "Could not connect to the agent service.",
      });
  };
  ws.onclose = (event) => {
    if (socket === ws) {
      const canReconnect =
        scope &&
        activeScope === scope &&
        event.code !== 4001 &&
        event.code !== 1008 &&
        Date.now() < scope.grant.expiresAt;
      // Keep revisions and grant revocation live while the relay is temporarily offline.
      if (!canReconnect) {
        stopTracking?.();
        stopTracking = undefined;
      }
      socket = undefined;
      useAgentConnection.setState({
        state: "disconnected",
        message: "Connection closed. Reconnect before editing.",
      });
      if (scope && activeScope === scope && (event.code === 4001 || event.code === 1008))
        activeScope = undefined;
      if (canReconnect) {
        reconnectTimer = setTimeout(() => {
          if (activeScope === scope) openSocket(endpoint, api, scope);
        }, 1500);
      }
    }
  };
}

function checkTarget(args: Record<string, unknown>, editable: boolean) {
  const design = useDesignStore.getState();
  if (args.sessionId !== sessionId)
    throw new AgentError("SESSION_CHANGED", "Read get_status and use the connected session id.");
  if (args.designId !== design.activeDesignId || !design.activeDesignId)
    throw new AgentError("DESIGN_CHANGED", "The target design is no longer on the canvas.");
  if (args.expectedRevision !== revision)
    throw new AgentError(
      "REVISION_CONFLICT",
      "The design changed. Read it again before continuing.",
      status(),
    );
  const factory = useFactoryStore.getState();
  if (
    editable &&
    (factory.isReadOnly ||
      factory.checklistMode ||
      liveDesignIdInThisTab() ||
      design.designs.find((entry) => entry.id === design.activeDesignId)?.cloud)
  )
    throw new AgentError(
      "READ_ONLY",
      "Agent edits require a local editable design with the construction checklist unlocked.",
    );
  if (editable && design.saveState === "error")
    throw new AgentError("SAVE_FAILED", "Resolve the webpage's save error before editing again.");
}

async function checkDataset(api: PlannerApi, args: Record<string, unknown>) {
  const page = identity();
  const requested = args.dataset as DatasetIdentity | undefined;
  const remote = await api.identity(page.versionId);
  if (
    !requested ||
    requested.versionId !== page.versionId ||
    requested.fingerprint !== page.fingerprint ||
    remote.fingerprint !== page.fingerprint
  )
    throw new AgentError(
      "DATASET_CHANGED",
      "The API, webpage and request must use the same dataset fingerprint. Reload the webpage and read status.",
    );
}

async function saved(designId: string) {
  const design = useDesignStore.getState();
  const canvas = useFactoryStore.getState().project;
  const outcome = await design.saveActiveProject(designId, canvas);
  const after = useDesignStore.getState();
  return {
    applied: true,
    persisted:
      after.saveState === "saved" &&
      (outcome?.outcome === "written" ||
        outcome?.outcome === "copied" ||
        (outcome?.outcome === "clean" && after.activeDesignId === designId)),
    savedDesignId: outcome?.outcome === "copied" ? outcome.copy.id : designId,
    activeDesignId: after.activeDesignId,
    conflictCopy: outcome?.outcome === "copied",
    error: after.saveState === "error" ? after.error : undefined,
  };
}

async function waitForBooks(capturedRevision: number) {
  const started = Date.now();
  while (useFactoryStore.getState().lastResult.stale) {
    if (revision !== capturedRevision)
      throw new AgentError("REVISION_CONFLICT", "The design changed during its solve.");
    if (Date.now() - started > 45_000)
      throw new AgentError("SOLVE_TIMEOUT", "The current revision has not finished solving.");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (revision !== capturedRevision)
    throw new AgentError("REVISION_CONFLICT", "The design changed during its solve.");
  return useFactoryStore.getState().lastResult;
}

export async function executeBrowserCommand(
  command: BrowserCommand,
  api: PlannerApi,
  isConnected: () => boolean = () => true,
  scope?: BrowserScope,
) {
  const checkConnected = () => {
    if (!isConnected())
      throw new AgentError(
        "BROWSER_DISCONNECTED",
        "Disconnected before this command could commit.",
      );
  };
  const args = command.args;
  if (scope && args.designId !== undefined && !scope.designIds.has(String(args.designId)))
    throw new AgentError("PERMISSION_DENIED", "This design was not authorized.");
  if (command.method === "list_designs")
    return {
      ...status(),
      designs: useDesignStore
        .getState()
        .designs.filter((entry) => !scope || scope.designIds.has(entry.id))
        .map(({ id, name, cloud, taskBoard }) => ({
          id,
          name,
          editable: !cloud && !taskBoard,
        })),
    };
  if (command.method === "get_machine_options") {
    await checkDataset(api, args);
    return machineOptions(await api.recipe(identity().versionId, z.string().parse(args.recipeId)));
  }
  if (
    MUTATIONS.has(command.method) ||
    command.method === "evaluate_design" ||
    command.method === "export_design"
  )
    await checkDataset(api, args);
  checkConnected();
  if (command.method === "create_design" || command.method === "open_design") {
    if (args.sessionId !== sessionId || args.expectedRevision !== revision)
      throw new AgentError(
        "REVISION_CONFLICT",
        "Read current status before changing the active design.",
      );
    if (command.method === "create_design") {
      if (scope && (!scope.grant.allowCreate || scope.designIds.size >= 100))
        throw new AgentError(
          "PERMISSION_DENIED",
          "New designs were not authorized, or the grant is full.",
        );
      const name = z.string().min(1).max(80).parse(args.name);
      const project = createNewProject();
      const capturedRevision = revision;
      if (scope) scope.creating = true;
      try {
        await useDesignStore.getState().importProjectAsDesign({ ...project, name }, name, (id) => {
          checkConnected();
          if (scope && revision !== capturedRevision)
            throw new AgentError(
              "REVISION_CONFLICT",
              "The design changed while creating a new one.",
            );
          scope?.designIds.add(id);
        });
      } finally {
        if (scope) scope.creating = false;
      }
    } else {
      const id = z.string().parse(args.designId);
      const target = useDesignStore.getState().designs.find((entry) => entry.id === id);
      if (!target || target.cloud || target.taskBoard)
        throw new AgentError("NOT_FOUND", "Choose a local factory design.");
      await useDesignStore.getState().switchToDesign(id);
    }
    return status();
  }
  checkTarget(args, MUTATIONS.has(command.method));
  const factory = useFactoryStore.getState();
  if (command.method === "get_design")
    return {
      ...status(),
      project: designView(
        factory.project,
        args.detail === "full",
        Number(args.offset ?? 0),
        Number(args.limit ?? 20),
        args.entityIds as string[] | undefined,
      ),
    };
  if (command.method === "apply_design_actions") {
    const actions = actionsSchema.parse(args.actions);
    const versionId = identity().versionId;
    const recipeIds = [
      ...new Set(actions.flatMap((action) => ("recipeId" in action ? [action.recipeId] : []))),
    ];
    const recipes = [];
    for (const id of recipeIds) recipes.push(await api.recipe(versionId, id));
    await checkDataset(api, args);
    checkConnected();
    checkTarget(args, true);
    const original = useFactoryStore.getState().project;
    const edit = applyAgentActions(original, actions, recipes, () => crypto.randomUUID());
    const committed = runAgentCanvasEdit(() =>
      useFactoryStore.getState().commitAgentEdit(original, edit.project),
    );
    if (!committed)
      throw new AgentError(
        "REVISION_CONFLICT",
        "The design changed before the batch could commit.",
      );
    return { ...(await saved(String(args.designId))), refs: edit.refs, ...status() };
  }
  if (command.method === "undo_design" || command.method === "redo_design") {
    runAgentCanvasEdit(() => (command.method === "undo_design" ? factory.undo() : factory.redo()));
    return { ...(await saved(String(args.designId))), ...status() };
  }
  if (command.method === "evaluate_design") {
    const constraints = constraintsSchema.parse(args.constraints);
    const capturedRevision = revision;
    const result = await waitForBooks(capturedRevision);
    checkTarget(args, false);
    return {
      ...status(),
      ...evaluateDesign(useFactoryStore.getState().project, result, constraints),
    };
  }
  if (command.method === "arrange_design") {
    const original = factory.project;
    if (original.pockets?.length || original.annotations?.length)
      throw new AgentError(
        "LAYOUT_UNSUPPORTED",
        "Arrange grouped or annotated designs with the webpage's arrange control.",
      );
    await waitForBooks(revision);
    // The last solve may have just changed card heights; let the board publish those sizes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    checkTarget(args, true);
    const geometry = readBoardGeometry();
    const ids = new Set([...(original.storages ?? []), ...original.nodes].map((entry) => entry.id));
    const dimensions = geometry?.cards
      .filter((card) => ids.has(card.id))
      .map((card) => ({
        ...card,
        role: card.role === "storage" ? ("storage" as const) : ("machine" as const),
      }));
    if (
      !dimensions ||
      dimensions.length !== ids.size ||
      dimensions.some((card) => card.width <= 0 || card.height <= 0)
    )
      throw new AgentError(
        "LAYOUT_NOT_READY",
        "Open the plan board and wait for its card geometry before arranging.",
      );
    const { result } = await arrangeInWorker({
      cards: dimensions,
      wires: geometry!.wires,
    });
    checkConnected();
    checkTarget(args, true);
    const moves = new Map(result.moves.map((move) => [move.id, move.position]));
    const next = {
      ...original,
      nodes: original.nodes.map((node) =>
        moves.has(node.id) ? { ...node, position: moves.get(node.id)! } : node,
      ),
      storages: original.storages?.map((drawer) =>
        moves.has(drawer.id) ? { ...drawer, position: moves.get(drawer.id)! } : drawer,
      ),
    };
    if (!runAgentCanvasEdit(() => useFactoryStore.getState().commitAgentEdit(original, next)))
      throw new AgentError("REVISION_CONFLICT", "The design changed during layout.");
    useFactoryStore.getState().frameBoardNodes();
    return { ...(await saved(String(args.designId))), ...status() };
  }
  if (command.method === "export_design") {
    const code = await encodePlanCode(factory.project);
    checkTarget(args, false);
    return {
      ...status(),
      json: serializeFactoryProject(factory.project),
      code,
      url: `${api.baseUrl}/#p=${code}`,
    };
  }
  throw new AgentError("UNKNOWN_COMMAND", command.method);
}
