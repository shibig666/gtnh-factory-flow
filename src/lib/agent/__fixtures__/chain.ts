import type { FactoryProject, Recipe } from "@/lib/model/types";
import type { AgentAction, PlanningConstraints } from "../protocol";

/** Artificial recipes isolate protocol and conservation tests from changing published IDs. */
export const fixtureRecipes: Recipe[] = [
  {
    id: "fixture:smelt",
    name: "Fixture smelting",
    machineType: "Fixture Furnace",
    minimumTier: "LV",
    durationTicks: 20,
    eut: 4,
    inputs: [{ kind: "item", id: "fixture:dust", displayName: "Fixture Dust", amount: 1 }],
    outputs: [{ kind: "item", id: "fixture:ingot", displayName: "Fixture Ingot", amount: 1 }],
  },
  {
    id: "fixture:wire",
    name: "Fixture wire",
    machineType: "Fixture Wiremill",
    minimumTier: "LV",
    durationTicks: 40,
    eut: 8,
    inputs: [{ kind: "item", id: "fixture:ingot", displayName: "Fixture Ingot", amount: 1 }],
    outputs: [{ kind: "item", id: "fixture:wire", displayName: "Fixture Wire", amount: 2 }],
  },
];
export const fixtureProject: FactoryProject = {
  schemaVersion: 1,
  id: "fixture:project",
  name: "Fixture",
  planMode: true,
  solveMode: true,
  recipes: [],
  nodes: [],
  edges: [],
  storages: [],
  fuelProfiles: [],
};
export const fixtureActions: AgentAction[] = [
  { type: "add_recipe", ref: "smelter", recipeId: "fixture:smelt" },
  { type: "add_recipe", ref: "wiremill", recipeId: "fixture:wire" },
  {
    type: "add_drawer",
    ref: "dust",
    resource: { kind: "item", id: "fixture:dust" },
    role: "source",
    rule: "ignore",
  },
  {
    type: "add_drawer",
    ref: "product",
    resource: { kind: "item", id: "fixture:wire" },
    role: "product",
    rate: 2,
    rule: "exact",
  },
  {
    type: "connect",
    source: { entityId: "dust", section: 0, port: 0 },
    target: { entityId: "smelter", section: 0, port: 0 },
  },
  {
    type: "connect",
    source: { entityId: "smelter", section: 0, port: 0 },
    target: { entityId: "wiremill", section: 0, port: 0 },
  },
  {
    type: "connect",
    source: { entityId: "wiremill", section: 0, port: 0 },
    target: { entityId: "product", section: 0, port: 0 },
  },
];
export const fixtureConstraints: PlanningConstraints = {
  targets: [{ resource: { kind: "item", id: "fixture:wire" }, perSecond: 2 }],
  maxTier: "LV",
  allowedInputs: [{ resource: { kind: "item", id: "fixture:dust" }, maxPerSecond: 1 }],
  allowedOutputs: [],
};
