import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PlannerApi, compactData, recipeView } from "@/lib/agent/data-client";
import {
  actionsSchema,
  constraintsSchema,
  resourceRefSchema,
  AgentError,
  errorResult,
} from "@/lib/agent/protocol";
import type { BrowserBridge } from "./bridge";

const id = z.string().min(1).max(512);
const dataset = z.object({ versionId: id, fingerprint: id }).strict();
const target = { sessionId: id, designId: id, expectedRevision: z.number().int().nonnegative() };
const mutation = { ...target, requestId: id, dataset };
const paging = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(120).default(20),
};

export function createMcpServer(api: PlannerApi, bridge: BrowserBridge) {
  const server = new McpServer(
    { name: "gtnh-factory-flow", version: "1.0.0" },
    {
      instructions:
        "Query recipes through the configured planner HTTP API. Pair a local webpage for edits. Read get_status/get_design before editing; copy its session, revision and dataset fingerprint. Batches are atomic and undoable. Never retry an unknown write without inspecting the design. Ask for target rates, max tier and external inputs. Solve success alone does not prove completion: use evaluate_design with all task constraints. Recipe IDs are authoritative; recipes are read-only.",
    },
  );
  function register<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    readOnly: boolean,
    run: (args: z.infer<S>) => Promise<unknown> | unknown,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema as z.ZodObject<z.ZodRawShape>,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      async (raw) => {
        try {
          const result = await run(schema.parse(raw));
          const failed =
            result && typeof result === "object" && "ok" in result && result.ok === false;
          const structured =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : { result };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(structured) }],
            structuredContent: structured,
            ...(failed ? { isError: true } : {}),
          };
        } catch (error) {
          const structured = { error: errorResult(error) };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(structured) }],
            structuredContent: structured,
          };
        }
      },
    );
  }
  async function pinned(versionId?: string) {
    if (versionId) return api.identity(versionId);
    const manifest = await api.manifest();
    const supported = manifest.versions.filter((entry) => entry.gtnhVersion.startsWith("2.9"));
    const selected =
      supported.find((entry) => entry.id === manifest.latestStableVersion) ??
      supported.find((entry) => entry.id === manifest.latestDailyVersion) ??
      supported[0];
    if (!selected)
      throw new AgentError("DATASET_UNAVAILABLE", "The API offers no GTNH 2.9 dataset.");
    return api.identity(selected.id);
  }
  register(
    "get_status",
    "Read the configured API origin, browser connection, current design, revision and dataset. No pairing code is exposed.",
    z.object({}).strict(),
    true,
    () => bridge.status(),
  );
  register(
    "begin_pairing",
    "Create a pairing code for the local webpage's Settings > Agent panel. Replaces the previous browser connection.",
    z.object({}).strict(),
    false,
    () => bridge.beginPairing(),
  );
  register(
    "list_datasets",
    "List website-provided GTNH 2.9 datasets. Does not read local dataset files.",
    z.object({}).strict(),
    true,
    async () => {
      const manifest = await api.manifest();
      return {
        ...manifest,
        versions: manifest.versions.filter((entry) => entry.gtnhVersion.startsWith("2.9")),
      };
    },
  );
  register(
    "get_catalog",
    "Page through recipe maps or machine family summaries from the configured website API. Use get_machine_options for a recipe's actual capabilities.",
    z
      .object({
        versionId: id.optional(),
        section: z.enum(["recipeMaps", "machines"]).default("recipeMaps"),
        query: z.string().max(500).default(""),
        ...paging,
      })
      .strict(),
    true,
    async ({ versionId, section, query, offset, limit }) => {
      const identity = await pinned(versionId);
      const catalog = await api.catalog(identity.versionId);
      const entries =
        section === "recipeMaps"
          ? ((catalog.recipeMaps as string[]) ?? [])
          : (
              (catalog.machineHandlerIcons ?? []) as Array<{
                familyId: string;
                resource?: { displayName?: string };
                tiers?: Array<{ tier: string }>;
              }>
            ).map((entry) => ({
              id: entry.familyId,
              name: entry.resource?.displayName,
              tiers: entry.tiers?.map((tier) => tier.tier),
            }));
      const matches = entries.filter((entry) =>
        JSON.stringify(entry).toLowerCase().includes(query.toLowerCase()),
      );
      return {
        dataset: identity,
        recipeCount: catalog.recipeCount,
        section,
        entries: matches.slice(offset, offset + limit),
        total: matches.length,
        offset,
        limit,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
      };
    },
  );
  register(
    "search_resources",
    "Search or page through API-visible items, fluids and aspects. Empty query lists resources. Only exact returned IDs may be used for edits.",
    z
      .object({
        versionId: id.optional(),
        query: z.string().max(500).default(""),
        kind: z.enum(["item", "fluid"]).optional(),
        mod: id.optional(),
        ...paging,
      })
      .strict(),
    true,
    async ({ versionId, ...query }) => {
      const identity = await pinned(versionId);
      const result = await api.resources(identity.versionId, query);
      return {
        dataset: identity,
        ...result,
        resources: compactData(result.resources),
        nextOffset: result.hasMore ? result.offset + result.resources.length : null,
      };
    },
  );
  register(
    "search_recipes",
    "Search recipes or uses across all recipe maps, with optional resource and takes/makes clauses. Search summaries preserve amounts, chances and kept-input markers. Fetch selected recipes for full planning data.",
    z
      .object({
        versionId: id.optional(),
        query: z.string().max(500).default(""),
        resource: resourceRefSchema.optional(),
        mode: z.enum(["recipes", "uses"]).default("recipes"),
        clauses: z
          .array(
            z.object({ role: z.enum(["takes", "makes"]), resource: resourceRefSchema }).strict(),
          )
          .max(16)
          .optional(),
        takesOp: z.enum(["any", "all", "only"]).optional(),
        makesOp: z.enum(["any", "all", "only"]).optional(),
        recipeMap: id.optional(),
        maxTier: id.default("all"),
        ...paging,
      })
      .strict(),
    true,
    async ({ versionId, resource, clauses, ...query }) => {
      const identity = await pinned(versionId);
      const result = await api.recipes(identity.versionId, {
        ...query,
        resourceKind: resource?.kind,
        resourceId: resource?.id,
        clause: clauses?.map(
          (entry) => `${entry.role}:${entry.resource.kind}:${entry.resource.id}`,
        ),
      });
      return {
        dataset: identity,
        ...result,
        recipes: result.recipes.map((recipe) => recipeView(recipe, "summary")),
        nextOffset: result.hasMore ? result.offset + result.recipes.length : null,
      };
    },
  );
  register(
    "get_recipes",
    "Read up to 10 exact recipe IDs. planning omits visuals and large runtime tables, retaining gameplay metadata; full returns the original API body. Edits always fetch canonical full recipes independently.",
    z
      .object({
        versionId: id,
        recipeIds: z.array(id).min(1).max(10),
        detail: z.enum(["planning", "full"]).default("planning"),
      })
      .strict(),
    true,
    async ({ versionId, recipeIds, detail }) => {
      const identity = await pinned(versionId);
      const recipes = [];
      for (const recipeId of recipeIds)
        recipes.push(recipeView(await api.recipe(versionId, recipeId), detail));
      return { dataset: identity, recipes };
    },
  );
  register(
    "get_machine_options",
    "Ask the connected webpage for effective machine handlers, real tiers, configuration controls and power gates for a recipe.",
    z.object({ dataset, recipeId: id }).strict(),
    true,
    (args) => bridge.call("get_machine_options", args),
  );
  register(
    "list_designs",
    "List designs in the paired webpage's browser library.",
    z.object({}).strict(),
    true,
    (args) => bridge.call("list_designs", args),
  );
  register(
    "create_design",
    "Create and open a new local design without overwriting an existing one.",
    z
      .object({
        sessionId: id,
        expectedRevision: z.number().int().nonnegative(),
        requestId: id,
        dataset,
        name: z.string().min(1).max(80),
      })
      .strict(),
    false,
    (args) => bridge.call("create_design", args),
  );
  register(
    "open_design",
    "Explicitly open an existing local factory design. Read status after the switch.",
    z.object(mutation).strict(),
    false,
    (args) => bridge.call("open_design", args),
  );
  register(
    "get_design",
    "Page through the active design and effective numbered ports. Supply entityIds to inspect selected cards. planning omits opaque game data; full explicitly returns the entire project.",
    z
      .object({
        ...target,
        dataset: dataset.optional(),
        detail: z.enum(["planning", "full"]).default("planning"),
        entityIds: z.array(id).max(120).optional(),
        ...paging,
      })
      .strict(),
    true,
    (args) => bridge.call("get_design", args),
  );
  register(
    "apply_design_actions",
    "Apply 1–200 validated actions as one undo step, one solve and a guarded save. Use local refs for entities created earlier in this batch. All rates are per second, fluids in L/s. Persisted=false must be resolved before claiming success.",
    z.object({ ...mutation, actions: actionsSchema }).strict(),
    false,
    (args) => bridge.call("apply_design_actions", args),
  );
  register(
    "evaluate_design",
    "Wait for this revision's solver and check target products, allowed imports and their caps, tier, power and untreated outputs. Supply all task constraints. Only complete=true passes.",
    z.object({ ...target, dataset, constraints: constraintsSchema }).strict(),
    true,
    (args) => bridge.call("evaluate_design", args),
  );
  register(
    "arrange_design",
    "Arrange ungrouped, unannotated cards with the existing background layout worker, as one undo step. Grouped designs use the webpage arrange control.",
    z.object(mutation).strict(),
    false,
    (args) => bridge.call("arrange_design", args),
  );
  for (const name of ["undo_design", "redo_design"] as const)
    register(
      name,
      `${name === "undo_design" ? "Undo" : "Redo"} one ordinary webpage edit and save it. Check the current revision first.`,
      z.object(mutation).strict(),
      false,
      (args) => bridge.call(name, args),
    );
  register(
    "export_design",
    "Export the current project JSON, plan code and a share link. Opening them creates a new design.",
    z.object({ ...target, dataset }).strict(),
    true,
    (args) => bridge.call("export_design", args),
  );
  return server;
}
