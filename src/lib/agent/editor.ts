import { applyRecipeInputOverrides, inputOverrideAmount } from "@/lib/model/recipe-input-overrides";
import { applyEdgeInputOverride } from "@/lib/model/edge-input-overrides";
import { ENERGY_HATCH_TYPES, energyHatchTypeExistsAtTier } from "@/lib/machines/energy-hatches";
import {
  applyMachineHandlerToRecipe,
  getRecipeMachineConfigTierControls,
  getRecipeMachineHandlers,
  getRecipeCoilTierControl,
} from "@/lib/model/recipe-rules";
import {
  getSharedMachineHandlers,
  sectionNodeView,
  sectionHandleId,
  splitSectionHandleId,
  listNodeSections,
} from "@/lib/model/shared-machine";
import { ownsItsRecipe } from "@/lib/model/owns-recipe";
import { isRecipeInputConsumed, resourceMatchesInput, getResourceKey } from "@/lib/model/resources";
import { factoryProjectSchema } from "@/lib/model/schemas";
import { normalizeProjectHatchInputs } from "@/lib/solver/hatch-input";
import { getRuntimeCalculationOutputs } from "@/lib/solver/runtime-calculation";
import { prunePlanFields, renumberAfterSectionRemoved } from "@/lib/solver/plan/hygiene";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import { getNodePowerReport } from "@/lib/solver/power-report";
import { snapPositionToGrid } from "@/lib/board-grid";
import { canonicalizeResourceHandleId } from "@/lib/model/edge-identity";
import type {
  FactoryProject,
  FactoryNode,
  FactoryStorage,
  Recipe,
  ResourceAmount,
  ThroughputResult,
} from "@/lib/model/types";
import {
  AgentError,
  actionsSchema,
  type AgentAction,
  type PortRef,
  type PlanningConstraints,
} from "./protocol";
import { compactData } from "./data-client";

const tierIndex = (tier: string) => GT_VOLTAGE_TIERS.findIndex((entry) => entry.tier === tier);
const handle = (side: string, resource: ResourceAmount) =>
  `${side}:${resource.kind}:${encodeURIComponent(resource.id)}`;

export function effectiveSection(project: FactoryProject, node: FactoryNode, section: number) {
  if (section > (node.extraRecipes?.length ?? 0))
    throw new AgentError("BAD_PORT", "Recipe section does not exist.");
  const view = sectionNodeView(node, section);
  const recipe = project.recipes.find((entry) => entry.id === view.recipeId);
  if (!recipe) throw new AgentError("MISSING_RECIPE", view.recipeId);
  return {
    view,
    recipe: applyMachineHandlerToRecipe(applyRecipeInputOverrides(recipe, view), view),
  };
}

export function resolvePort(project: FactoryProject, ref: PortRef, side: "input" | "output") {
  const node = project.nodes.find((entry) => entry.id === ref.entityId);
  if (node) {
    const { recipe, view } = effectiveSection(project, node, ref.section);
    const slots =
      side === "input"
        ? recipe.inputs
        : (getRuntimeCalculationOutputs(recipe, view) ?? recipe.outputs);
    const resource = slots[ref.port];
    if (!resource || (side === "input" && !isRecipeInputConsumed(resource)))
      throw new AgentError("BAD_PORT", "Choose a consumed input or a real output port.");
    return { resource, handle: sectionHandleId(ref.section, handle(side, resource)) };
  }
  const drawer = project.storages?.find((entry) => entry.id === ref.entityId);
  if (!drawer || ref.section || ref.port)
    throw new AgentError("BAD_PORT", "Entity or port does not exist.");
  if (
    (drawer.poolSide === "source" && side === "input") ||
    (drawer.poolSide === "drain" && side === "output")
  )
    throw new AgentError("BAD_PORT", "Drawer has no port on this side.");
  const resource: ResourceAmount = {
    kind: drawer.kind,
    id: drawer.resourceId,
    amount: 1,
    displayName: drawer.displayName,
  };
  return { resource, handle: handle(side, resource) };
}

function validateMachine(project: FactoryProject, node: FactoryNode) {
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const handlers = getSharedMachineHandlers(node, recipes);
  const selected = node.machineHandlerId
    ? handlers.find((entry) => entry.id === node.machineHandlerId)
    : handlers[0];
  if (!selected)
    throw new AgentError("INVALID_MACHINE", "The machine cannot run every recipe section.");
  if (
    node.energyHatchType &&
    (!ENERGY_HATCH_TYPES.some((entry) => entry.id === node.energyHatchType) ||
      !energyHatchTypeExistsAtTier(
        node.energyHatchType,
        node.hatchVoltageTier ?? node.overclockTier,
      ))
  )
    throw new AgentError(
      "INVALID_SETTING",
      "This energy hatch is not available at the selected tier.",
    );
  const tier = tierIndex(node.overclockTier);
  if (
    tier < 0 ||
    tier < tierIndex(selected.minimumTier) ||
    (selected.maximumTier && tier > tierIndex(selected.maximumTier)) ||
    (selected.availableTiers?.length && !selected.availableTiers.includes(node.overclockTier))
  )
    throw new AgentError(
      "INVALID_TIER",
      "This machine does not exist or cannot run at the selected tier.",
    );
  for (const { section } of listNodeSections(node)) {
    const { recipe, view } = effectiveSection(project, node, section);
    const controls = getRecipeMachineConfigTierControls(recipe, view);
    const coil = getRecipeCoilTierControl(recipe, view);
    const choices = [...controls, ...(coil ? [coil] : [])];
    for (const [key, value] of Object.entries(node.machineConfigTiers ?? {})) {
      const control = choices.find((entry) => entry.id === key);
      if (!control) throw new AgentError("INVALID_SETTING", `Unknown machine setting: ${key}`);
      if (control.numeric) {
        const number = Number(value);
        const { min, max, step } = control.numeric;
        if (
          !Number.isFinite(number) ||
          number < min ||
          (max !== undefined && number > max) ||
          (step && Math.abs(number / step - Math.round(number / step)) > 1e-6)
        )
          throw new AgentError("INVALID_SETTING", `Invalid numeric setting: ${key}`);
      } else if (!control.tiers.some((entry) => entry.key === value))
        throw new AgentError("INVALID_SETTING", `Invalid option: ${key}`);
    }
    if (node.coilTier && !coil?.tiers.some((entry) => entry.key === node.coilTier))
      throw new AgentError("INVALID_SETTING", "Invalid coil tier.");
  }
}

/** Stage immutable edits first; the caller commits and solves the whole batch once. */
export function applyAgentActions(
  original: FactoryProject,
  rawActions: AgentAction[],
  canonicalRecipes: Recipe[],
  makeId: () => string,
) {
  const actions = actionsSchema.parse(rawActions);
  let project = original;
  const refs = new Map<string, string>();
  const recipes = new Map(canonicalRecipes.map((recipe) => [recipe.id, recipe]));
  const resolveId = (id: string) => refs.get(id) ?? id;
  const addRef = (ref: string, value: string) => {
    if (
      refs.has(ref) ||
      original.nodes.some((entry) => entry.id === ref) ||
      original.storages?.some((entry) => entry.id === ref)
    )
      throw new AgentError("DUPLICATE_REF", ref);
    refs.set(ref, value);
  };
  const nodeById = (id: string) => {
    const node = project.nodes.find((entry) => entry.id === resolveId(id));
    if (!node) throw new AgentError("NOT_FOUND", `Machine not found: ${id}`);
    return node;
  };
  const replaceNode = (node: FactoryNode) => {
    const positioned = { ...node, position: snapPositionToGrid(node.position) };
    project = {
      ...project,
      nodes: project.nodes.map((entry) => (entry.id === node.id ? positioned : entry)),
    };
  };
  const getRecipe = (id: string) => {
    const recipe = recipes.get(id);
    if (!recipe)
      throw new AgentError(
        "MISSING_RECIPE",
        "Only recipes loaded from the selected dataset may be added.",
      );
    project = {
      ...project,
      recipes: project.recipes.some((entry) => entry.id === id)
        ? project.recipes.map((entry) => (entry.id === id ? recipe : entry))
        : [...project.recipes, recipe],
    };
    return recipe;
  };
  const point = () => ({ x: (project.nodes.length + (project.storages?.length ?? 0)) * 480, y: 0 });
  const portRef = (ref: PortRef) => ({ ...ref, entityId: resolveId(ref.entityId) });
  const changedNodes = new Set<string>();
  for (const action of actions) {
    switch (action.type) {
      case "add_recipe": {
        const recipe = getRecipe(action.recipeId);
        const settings = action.settings ?? {};
        const selected =
          getRecipeMachineHandlers(recipe).find(
            (entry) => entry.id === settings.machineHandlerId,
          ) ?? getRecipeMachineHandlers(recipe)[0];
        const node = {
          id: makeId(),
          recipeId: recipe.id,
          machineCount: 1,
          parallel: 1,
          enabled: true,
          overclockTier: selected.minimumTier,
          position: point(),
          ...settings,
          solvePin: settings.solvePin ?? undefined,
        } as FactoryNode;
        node.position = snapPositionToGrid(node.position);
        addRef(action.ref, node.id);
        project = { ...project, nodes: [...project.nodes, node] };
        changedNodes.add(node.id);
        break;
      }
      case "update_machine": {
        const node = nodeById(action.nodeId);
        replaceNode({
          ...node,
          ...action.settings,
          solvePin:
            action.settings.solvePin === null
              ? undefined
              : (action.settings.solvePin ?? node.solvePin),
        } as FactoryNode);
        changedNodes.add(node.id);
        break;
      }
      case "replace_recipe": {
        const node = nodeById(action.nodeId);
        getRecipe(action.recipeId);
        if (node.extraRecipes?.length)
          throw new AgentError(
            "SHARED_MACHINE",
            "Remove extra recipe sections before replacing the primary recipe.",
          );
        replaceNode({ ...node, recipeId: action.recipeId, recipeInputOverrides: undefined });
        changedNodes.add(node.id);
        break;
      }
      case "add_recipe_section": {
        const node = nodeById(action.nodeId);
        const recipe = getRecipe(action.recipeId);
        const primary = project.recipes.find((entry) => entry.id === node.recipeId)!;
        if (ownsItsRecipe(primary) || ownsItsRecipe(recipe))
          throw new AgentError("SHARED_MACHINE", "This card cannot share recipes.");
        replaceNode({
          ...node,
          extraRecipes: [...(node.extraRecipes ?? []), { recipeId: recipe.id }],
        });
        changedNodes.add(node.id);
        break;
      }
      case "remove_recipe_section": {
        const node = nodeById(action.nodeId);
        const extras = node.extraRecipes ?? [];
        if (!extras.length || action.section > extras.length)
          throw new AgentError("BAD_SECTION", "Delete the card to remove its last recipe.");
        const sections = [
          { recipeId: node.recipeId, recipeInputOverrides: node.recipeInputOverrides },
          ...extras,
        ].filter((_, index) => index !== action.section);
        replaceNode({ ...node, ...sections[0], extraRecipes: sections.slice(1) });
        project = {
          ...project,
          edges: project.edges
            .filter(
              (edge) =>
                !(
                  edge.source === node.id &&
                  splitSectionHandleId(edge.sourceHandle).section === action.section
                ) &&
                !(
                  edge.target === node.id &&
                  splitSectionHandleId(edge.targetHandle).section === action.section
                ),
            )
            .map((edge) => {
              const renumber = (raw: string | undefined) => {
                const { section, handleId } = splitSectionHandleId(raw);
                return section > action.section && handleId
                  ? sectionHandleId(section - 1, handleId)
                  : raw;
              };
              return edge.source === node.id || edge.target === node.id
                ? {
                    ...edge,
                    sourceHandle:
                      edge.source === node.id ? renumber(edge.sourceHandle) : edge.sourceHandle,
                    targetHandle:
                      edge.target === node.id ? renumber(edge.targetHandle) : edge.targetHandle,
                  }
                : edge;
            }),
        };
        project = renumberAfterSectionRemoved(project, node.id, action.section);
        changedNodes.add(node.id);
        break;
      }
      case "select_input": {
        const node = nodeById(action.nodeId);
        const section = sectionNodeView(node, action.section);
        if (action.section > (node.extraRecipes?.length ?? 0))
          throw new AgentError("BAD_SECTION", "Recipe section does not exist.");
        const recipe = project.recipes.find((entry) => entry.id === section.recipeId)!;
        const input = recipe.inputs[action.port];
        const candidates = [...project.recipes, ...canonicalRecipes]
          .flatMap((entry) => [...entry.inputs, ...entry.outputs])
          .flatMap((entry) => [entry, ...(entry.alternatives ?? [])]);
        const concrete = candidates.find(
          (entry) => entry.kind === action.resource.kind && entry.id === action.resource.id,
        );
        if (!input || !concrete || !resourceMatchesInput(concrete, input))
          throw new AgentError(
            "INVALID_INPUT",
            "The selected resource does not satisfy this recipe input.",
          );
        const picks = {
          ...section.recipeInputOverrides,
          [String(action.port)]: {
            ...input,
            ...concrete,
            amount: inputOverrideAmount(
              input,
              concrete.kind,
              input.alternatives?.find(
                (entry) => entry.kind === concrete.kind && entry.id === concrete.id,
              ),
            ),
            consumed: input.consumed,
          },
        };
        replaceNode(
          action.section === 0
            ? { ...node, recipeInputOverrides: picks }
            : {
                ...node,
                extraRecipes: node.extraRecipes!.map((entry, index) =>
                  index === action.section - 1 ? { ...entry, recipeInputOverrides: picks } : entry,
                ),
              },
        );
        break;
      }
      case "add_drawer": {
        const found = [...project.recipes, ...canonicalRecipes]
          .flatMap((recipe) => [...recipe.inputs, ...recipe.outputs])
          .flatMap((entry) => [entry, ...(entry.alternatives ?? [])])
          .find((entry) => entry.kind === action.resource.kind && entry.id === action.resource.id);
        if (!found)
          throw new AgentError(
            "UNKNOWN_RESOURCE",
            "Add the relevant recipe first so the drawer uses a verified resource.",
          );
        const drawer: FactoryStorage = {
          id: makeId(),
          kind: found.kind,
          resourceId: found.id,
          displayName: found.displayName,
          iconPath: found.iconPath,
          iconAtlas: found.iconAtlas,
          dominantColor: found.dominantColor,
          position: point(),
          poolSide:
            action.role === "source" ? "source" : action.role === "buffer" ? undefined : "drain",
          drainMode:
            action.role === "byproduct" || action.role === "trash" ? action.role : "product",
          bufferMode: action.role === "buffer" ? "strict" : undefined,
          targetMode: action.rule,
          targetPerSecond:
            action.rate === undefined
              ? undefined
              : action.rate * (action.role === "source" ? -1 : 1),
        };
        if (action.rule !== "ignore" && action.rate === undefined)
          throw new AgentError("MISSING_RATE", "A drawer rule needs a rate.");
        addRef(action.ref, drawer.id);
        project = { ...project, storages: [...(project.storages ?? []), drawer] };
        break;
      }
      case "set_drawer_rule": {
        const drawer = project.storages?.find((entry) => entry.id === resolveId(action.drawerId));
        if (!drawer) throw new AgentError("NOT_FOUND", action.drawerId);
        if (action.rule !== "ignore" && action.rate === undefined)
          throw new AgentError("MISSING_RATE", "A drawer rule needs a rate.");
        project = {
          ...project,
          storages: project.storages!.map((entry) =>
            entry === drawer
              ? {
                  ...entry,
                  targetMode: action.rule,
                  targetPerSecond:
                    action.rate === undefined
                      ? undefined
                      : action.rate * (drawer.poolSide === "source" ? -1 : 1),
                  ...(action.drainMode ? { drainMode: action.drainMode } : {}),
                }
              : entry,
          ),
        };
        break;
      }
      case "connect": {
        const source = portRef(action.source),
          target = portRef(action.target);
        const output = resolvePort(project, source, "output"),
          input = resolvePort(project, target, "input");
        if (!resourceMatchesInput(output.resource, input.resource))
          throw new AgentError(
            "INCOMPATIBLE_PORTS",
            "Ports must have compatible resources of the same kind. Use a real conversion recipe for cells and fluids.",
          );
        if (
          project.edges.some(
            (edge) =>
              edge.source === source.entityId &&
              edge.target === target.entityId &&
              canonicalizeResourceHandleId(edge.sourceHandle) === output.handle &&
              canonicalizeResourceHandleId(edge.targetHandle) === input.handle,
          )
        )
          throw new AgentError("DUPLICATE_EDGE", "These ports are already connected.");
        const edgeId = makeId();
        if (action.ref) addRef(action.ref, edgeId);
        project = {
          ...project,
          edges: [
            ...project.edges,
            {
              id: edgeId,
              source: source.entityId,
              target: target.entityId,
              sourceHandle: output.handle,
              targetHandle: input.handle,
              resourceKind: output.resource.kind,
              resourceId: output.resource.id,
            },
          ],
        };
        project = applyEdgeInputOverride(
          project,
          project.edges[project.edges.length - 1],
          output.resource,
        );
        break;
      }
      case "disconnect": {
        const edgeId = resolveId(action.edgeId);
        if (!project.edges.some((entry) => entry.id === edgeId))
          throw new AgentError("NOT_FOUND", edgeId);
        project = { ...project, edges: project.edges.filter((entry) => entry.id !== edgeId) };
        break;
      }
      case "remove_entity": {
        const entityId = resolveId(action.entityId);
        if (
          !project.nodes.some((entry) => entry.id === entityId) &&
          !project.storages?.some((entry) => entry.id === entityId)
        )
          throw new AgentError("NOT_FOUND", entityId);
        project = {
          ...project,
          nodes: project.nodes.filter((entry) => entry.id !== entityId),
          storages: project.storages?.filter((entry) => entry.id !== entityId),
          edges: project.edges.filter(
            (entry) => entry.source !== entityId && entry.target !== entityId,
          ),
        };
        changedNodes.delete(entityId);
        break;
      }
      case "set_port_rate": {
        const ref = portRef(action.port);
        const node = nodeById(ref.entityId);
        const selected = resolvePort(project, ref, action.side);
        const rates = { ...node.portRates };
        if (action.rate === null) delete rates[selected.handle];
        else rates[selected.handle] = action.rate;
        replaceNode({ ...node, portRates: rates });
        break;
      }
    }
  }
  for (const node of project.nodes) if (changedNodes.has(node.id)) validateMachine(project, node);
  project = normalizeProjectHatchInputs(project, true);
  // Recipe or setting changes may invalidate an old wire. Refuse rather than silently dropping it.
  for (const edge of project.edges) {
    const find = (entityId: string, raw: string | undefined, side: "input" | "output") => {
      const { section } = splitSectionHandleId(raw);
      const node = project.nodes.find((entry) => entry.id === entityId);
      if (!node) return resolvePort(project, { entityId, section: 0, port: 0 }, side);
      const { recipe, view } = effectiveSection(project, node, section);
      const slots =
        side === "input"
          ? recipe.inputs
          : (getRuntimeCalculationOutputs(recipe, view) ?? recipe.outputs);
      const port = slots.findIndex(
        (entry) =>
          sectionHandleId(section, handle(side, entry)) === canonicalizeResourceHandleId(raw) ||
          (!raw && entry.kind === edge.resourceKind && entry.id === edge.resourceId),
      );
      return resolvePort(project, { entityId, section, port }, side);
    };
    const source = find(edge.source, edge.sourceHandle, "output"),
      target = find(edge.target, edge.targetHandle, "input");
    if (!resourceMatchesInput(source.resource, target.resource))
      throw new AgentError(
        "INVALIDATED_WIRE",
        "Disconnect incompatible wires in the same batch before changing the recipe or its input selection.",
      );
  }
  project = prunePlanFields(project);
  factoryProjectSchema.parse(project);
  return { project, refs: Object.fromEntries(refs) };
}

export function machineOptions(recipe: Recipe, settings: Partial<FactoryNode> = {}) {
  return getRecipeMachineHandlers(recipe).map((handler) => {
    const node = {
      machineCount: 1,
      parallel: 1,
      enabled: true,
      overclockTier: handler.minimumTier,
      ...settings,
      machineHandlerId: handler.id,
    } as FactoryNode;
    const effective = applyMachineHandlerToRecipe(recipe, node);
    return compactData({
      handler,
      controls: getRecipeMachineConfigTierControls(effective, node),
      coil: getRecipeCoilTierControl(effective, node),
      power: getNodePowerReport(effective, node),
    });
  });
}

export function designView(
  project: FactoryProject,
  full = false,
  offset = 0,
  limit = 20,
  entityIds?: string[],
) {
  if (full) return project;
  const select = <T extends { id: string }>(entries: T[]) =>
    (entityIds ? entries.filter((entry) => entityIds.includes(entry.id)) : entries).slice(
      offset,
      offset + limit,
    );
  const counts = {
    nodes: project.nodes.length,
    storages: project.storages?.length ?? 0,
    edges: project.edges.length,
  };
  const matchedCounts = entityIds
    ? {
        nodes: project.nodes.filter((entry) => entityIds.includes(entry.id)).length,
        storages: project.storages?.filter((entry) => entityIds.includes(entry.id)).length ?? 0,
        edges: project.edges.filter((entry) => entityIds.includes(entry.id)).length,
      }
    : counts;
  return compactData({
    id: project.id,
    name: project.name,
    counts,
    matchedCounts,
    offset,
    limit,
    nextOffset: Math.max(...Object.values(matchedCounts)) > offset + limit ? offset + limit : null,
    nodes: select(project.nodes).map((node) => {
      const {
        gtnhplanner,
        recipeInputOverrides: _overrides,
        extraRecipes: _extras,
        ...settings
      } = node;
      void _overrides;
      void _extras;
      return {
        ...settings,
        hasGameData: Boolean(gtnhplanner),
        sections: listNodeSections(node).map(({ section }) => {
          const { recipe, view } = effectiveSection(project, node, section);
          return {
            section,
            recipeId: recipe.id,
            name: recipe.name,
            inputs: recipe.inputs.map((entry, port) => ({
              ...entry,
              port,
              consumed: isRecipeInputConsumed(entry),
            })),
            outputs: (getRuntimeCalculationOutputs(recipe, view) ?? recipe.outputs).map(
              (entry, port) => ({ ...entry, port }),
            ),
          };
        }),
      };
    }),
    storages: select(project.storages ?? []).map(({ gtnhplanner, ...drawer }) => ({
      ...drawer,
      hasGameData: Boolean(gtnhplanner),
    })),
    edges: select(project.edges).map(({ gtnhplanner, ...edge }) => ({
      ...edge,
      hasGameData: Boolean(gtnhplanner),
    })),
  });
}

export function evaluateDesign(
  project: FactoryProject,
  result: ThroughputResult,
  constraints: PlanningConstraints,
) {
  const issues: Array<{ code: string; detail: unknown }> = [];
  const add = (code: string, detail: unknown) => issues.push({ code, detail });
  if (result.stale) add("STALE_RESULT", "Wait for this revision to finish solving.");
  if (!result.plan || result.plan.failure) add("SOLVE_FAILED", result.plan?.failure);
  const allowed = new Map(
    constraints.allowedInputs.map((entry) => [getResourceKey(entry.resource), entry]),
  );
  const imports = new Map<string, number>();
  for (const resource of Object.values(result.resources))
    if (resource.importedPerSecond > 1e-8) imports.set(resource.key, resource.importedPerSecond);
  const terminalRate = (entry: { nodeId: string; portKey: string }) => {
    const nodeId = entry.nodeId.replace(/#r\d+$/, "");
    const node = project.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return undefined;
    const raw = entry.portKey.split("|").slice(2).join("|");
    const [, kind, encoded] = raw.split(":");
    return kind && encoded ? `${kind}:${decodeURIComponent(encoded)}` : undefined;
  };
  for (const forced of result.plan?.forced ?? [])
    if (forced.side === "in")
      imports.set(forced.resourceKey, (imports.get(forced.resourceKey) ?? 0) + forced.perSecond);
  for (const terminal of result.plan?.terminals ?? [])
    if (terminal.side === "in") {
      const key = terminalRate(terminal);
      if (key) imports.set(key, (imports.get(key) ?? 0) + terminal.perSecond);
    }
  for (const [key, amount] of imports) {
    if (key.startsWith("power:")) continue;
    const rule = allowed.get(key as `${ResourceAmount["kind"]}:${string}`);
    if (!rule) add("UNAPPROVED_INPUT", { resourceKey: key, perSecond: amount });
    else if (
      rule.maxPerSecond !== undefined &&
      amount > rule.maxPerSecond + 1e-6 * Math.max(1, rule.maxPerSecond)
    )
      add("INPUT_LIMIT", { resourceKey: key, perSecond: amount, limit: rule.maxPerSecond });
  }
  const targets = constraints.targets.map((target) => {
    const key = getResourceKey(target.resource);
    const actual = result.resources[key]?.productPerSecond ?? 0;
    const met = actual + 1e-6 * Math.max(1, target.perSecond) >= target.perSecond;
    if (!met) add("TARGET_SHORTFALL", { resourceKey: key, actual, target: target.perSecond });
    return { resourceKey: key, target: target.perSecond, actual, met };
  });
  const allowedOutputs = new Set(
    [...constraints.allowedOutputs, ...constraints.targets.map((entry) => entry.resource)].map(
      getResourceKey,
    ),
  );
  for (const forced of result.plan?.forced ?? [])
    if (
      forced.side === "out" &&
      forced.perSecond > 1e-8 &&
      !allowedOutputs.has(forced.resourceKey as `${ResourceAmount["kind"]}:${string}`)
    )
      add("UNHANDLED_OUTPUT", forced);
  for (const terminal of result.plan?.terminals ?? [])
    if (terminal.side === "out" && terminal.perSecond > 1e-8) {
      const key = terminalRate(terminal);
      if (key && !allowedOutputs.has(key as `${ResourceAmount["kind"]}:${string}`))
        add("UNHANDLED_OUTPUT", { ...terminal, resourceKey: key });
    }
  for (const resource of Object.values(result.resources))
    if (resource.bufferFillPerSecond > 1e-8)
      add("BUFFER_ACCUMULATION", {
        resourceKey: resource.key,
        perSecond: resource.bufferFillPerSecond,
      });
  if (tierIndex(constraints.maxTier) < 0)
    throw new AgentError("INVALID_TIER", "Unknown maximum technology tier.");
  for (const node of project.nodes) {
    for (const { section } of listNodeSections(node)) {
      const { recipe, view } = effectiveSection(project, node, section);
      const power = getNodePowerReport(recipe, view);
      if (
        tierIndex(power.tier) > tierIndex(constraints.maxTier) ||
        tierIndex(recipe.minimumTier) > tierIndex(constraints.maxTier)
      )
        add("TIER_LIMIT", {
          nodeId: node.id,
          section,
          tier: power.tier,
          recipeTier: recipe.minimumTier,
        });
      if (power.state !== "ok" || power.recipeGateReason)
        add("MACHINE_GATE", { nodeId: node.id, section, power });
    }
  }
  if (
    constraints.powerBudgetEuT !== undefined &&
    result.totalEuT > constraints.powerBudgetEuT + 1e-6
  )
    add("POWER_LIMIT", { required: result.totalEuT, limit: constraints.powerBudgetEuT });
  if (result.plan?.unmetDrawers?.length || result.plan?.shortfalls?.length)
    add("UNMET_DRAWERS", result.plan.shortfalls ?? result.plan.unmetDrawers);
  if (result.plan?.unanchored.length) add("UNANCHORED", result.plan.unanchored);
  if (result.plan?.loops?.length) add("LOOP", result.plan.loops);
  return {
    complete: issues.length === 0,
    targets,
    issues,
    externalInputs: Object.fromEntries(imports),
    totalEuT: result.totalEuT,
    machines: Object.values(result.nodes).map((node) => ({
      nodeId: node.nodeId,
      theoretical: node.theoreticalMachinesRequired,
      buildCount: Math.ceil(node.theoreticalMachinesRequired ?? 0),
      warnings: node.warnings,
    })),
    plan: result.plan,
  };
}
