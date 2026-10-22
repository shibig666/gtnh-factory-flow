import { beforeAll, describe, expect, it } from "vitest";
import { applyAgentActions, designView, evaluateDesign, machineOptions } from "./editor";
import {
  fixtureProject,
  fixtureRecipes,
  fixtureActions,
  fixtureConstraints,
} from "./__fixtures__/chain";
import { calculateThroughput } from "@/lib/solver";
import { initLpEngine } from "@/lib/solver/lp-engine";
import { useFactoryStore } from "@/store/factory-store";

beforeAll(async () => {
  await initLpEngine();
});
const build = () => {
  let id = 0;
  return applyAgentActions(fixtureProject, fixtureActions, fixtureRecipes, () => `entity-${++id}`);
};

describe("agent edits and independent task checks", () => {
  it("constructs a two-stage chain whose real solver meets the target", () => {
    const { project } = build();
    const result = calculateThroughput(project);
    const report = evaluateDesign(project, result, fixtureConstraints);
    expect(report.complete, JSON.stringify(report.issues)).toBe(true);
    expect(report.targets[0].actual).toBeCloseTo(2);
    expect(report.externalInputs["item:fixture:dust"]).toBeCloseTo(1);
    expect(project.nodes).toHaveLength(2);
    expect(fixtureProject.nodes).toHaveLength(0);
  });
  it("never partially applies a batch with an invalid final action", () => {
    expect(() =>
      applyAgentActions(
        fixtureProject,
        [
          ...fixtureActions,
          { type: "update_machine", nodeId: "wiremill", settings: { overclockTier: "fictional" } },
        ],
        fixtureRecipes,
        () => crypto.randomUUID(),
      ),
    ).toThrow();
    expect(fixtureProject.nodes).toEqual([]);
    expect(fixtureProject.recipes).toEqual([]);
  });
  it("refuses fake recipe IDs, unknown knobs and duplicate local refs", () => {
    expect(() =>
      applyAgentActions(
        fixtureProject,
        [{ type: "add_recipe", ref: "a", recipeId: "invented" }],
        fixtureRecipes,
        () => "id",
      ),
    ).toThrow(/selected dataset/);
    expect(() =>
      applyAgentActions(
        fixtureProject,
        [
          {
            type: "add_recipe",
            ref: "a",
            recipeId: "fixture:wire",
            settings: { machineConfigTiers: { invented: "yes" } },
          },
        ],
        fixtureRecipes,
        () => "id",
      ),
    ).toThrow(/Unknown machine setting/);
    expect(() =>
      applyAgentActions(
        fixtureProject,
        [fixtureActions[0], fixtureActions[0]],
        fixtureRecipes,
        () => crypto.randomUUID(),
      ),
    ).toThrow();
  });
  it("keeps unknown in-game data and untouched object identities", () => {
    const built = build();
    const original = { ...built.project, gtnhplanner: { arbitrary: [1, { key: "value" }] } };
    const { project } = applyAgentActions(
      original,
      [{ type: "update_machine", nodeId: built.refs.wiremill, settings: { parallel: 2 } }],
      [],
      () => "new",
    );
    expect(project.gtnhplanner).toBe(original.gtnhplanner);
    expect(project.nodes[0]).toBe(original.nodes[0]);
  });
  it("does not accept a successful solve that imports a forbidden intermediate", () => {
    const built = build();
    const edge = built.project.edges.find((entry) => entry.source === built.refs.smelter)!;
    const { project } = applyAgentActions(
      built.project,
      [{ type: "disconnect", edgeId: edge.id }],
      [],
      () => "new",
    );
    const report = evaluateDesign(project, calculateThroughput(project), fixtureConstraints);
    expect(report.complete).toBe(false);
    expect(report.issues.some((entry) => entry.code === "UNAPPROVED_INPUT")).toBe(true);
  });
  it("detects supply and power limits independently of solver success", () => {
    const { project } = build();
    const result = calculateThroughput(project);
    const report = evaluateDesign(project, result, {
      ...fixtureConstraints,
      powerBudgetEuT: 0,
      allowedInputs: [{ resource: { kind: "item", id: "fixture:dust" }, maxPerSecond: 0.5 }],
    });
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["INPUT_LIMIT", "POWER_LIMIT"]),
    );
    expect(evaluateDesign(project, { ...result, stale: true }, fixtureConstraints).complete).toBe(
      false,
    );
  });
  it("will not connect fluid output to an item input", () => {
    const recipes = structuredClone(fixtureRecipes);
    recipes[0].outputs[0].kind = "fluid";
    expect(() =>
      applyAgentActions(fixtureProject, fixtureActions, recipes, () => crypto.randomUUID()),
    ).toThrow(/compatible resources/);
  });
  it("presents effective section ports and machine choices without visuals", () => {
    const { project } = build();
    expect(JSON.stringify(designView(project))).toContain('"port":0');
    expect(machineOptions(fixtureRecipes[0])).toHaveLength(1);
  });

  it("redocks concrete ore-dictionary inputs using the same rule as manual wiring", () => {
    const recipes = structuredClone(fixtureRecipes);
    recipes[1].inputs[0] = {
      kind: "item",
      id: "oredict:ingotFixture",
      amount: 1,
      alternatives: [{ kind: "item", id: "fixture:ingot", displayName: "Fixture Ingot" }],
    };
    const { project, refs } = applyAgentActions(fixtureProject, fixtureActions, recipes, () =>
      crypto.randomUUID(),
    );
    const wiremill = project.nodes.find((entry) => entry.id === refs.wiremill)!;
    expect(wiremill.recipeInputOverrides?.["0"].id).toBe("fixture:ingot");
    expect(project.edges.find((entry) => entry.target === refs.wiremill)?.targetHandle).toBe(
      "input:item:fixture%3Aingot",
    );
    expect(evaluateDesign(project, calculateThroughput(project), fixtureConstraints).complete).toBe(
      true,
    );
  });

  it("accepts existing indexed handles and keeps unrelated cards unchanged", () => {
    const { project: original, refs } = build();
    const project = {
      ...original,
      edges: original.edges.map((entry) => ({
        ...entry,
        sourceHandle: `${entry.sourceHandle}:0`,
        targetHandle: `${entry.targetHandle}:0`,
      })),
    };
    expect(() =>
      applyAgentActions(
        project,
        [{ type: "update_machine", nodeId: refs.wiremill, settings: { parallel: 2 } }],
        [],
        () => "unused",
      ),
    ).not.toThrow();
  });

  it("paginates planning views while keeping full detail explicit", () => {
    const { project } = build();
    const view = designView(project, false, 0, 1) as {
      nodes: unknown[];
      nextOffset: number;
      counts: { nodes: number };
    };
    expect(view.nodes).toHaveLength(1);
    expect(view.counts.nodes).toBe(2);
    expect(view.nextOffset).toBe(1);
    expect(
      designView(
        project,
        false,
        0,
        1,
        project.nodes.map((entry) => entry.id),
      ),
    ).toMatchObject({ nextOffset: 1, matchedCounts: { nodes: 2 } });
    expect(designView(project, true)).toBe(project);
  });
  it("commits a batch as one undo step and refuses stale or read-only commits", () => {
    useFactoryStore.getState().markHydratedProject(fixtureProject);
    const original = useFactoryStore.getState().project;
    const { project } = applyAgentActions(original, fixtureActions, fixtureRecipes, () =>
      crypto.randomUUID(),
    );
    expect(useFactoryStore.getState().commitAgentEdit(original, project)).toBe(true);
    expect(useFactoryStore.getState().undoHistory).toHaveLength(1);
    expect(useFactoryStore.getState().commitAgentEdit(original, project)).toBe(false);
    useFactoryStore.getState().undo();
    expect(useFactoryStore.getState().project.nodes).toHaveLength(0);
    useFactoryStore.getState().redo();
    expect(useFactoryStore.getState().project.nodes).toHaveLength(2);
    useFactoryStore.getState().loadViewedProject(project);
    expect(
      useFactoryStore.getState().commitAgentEdit(useFactoryStore.getState().project, project),
    ).toBe(false);
    useFactoryStore.getState().markHydratedProject(fixtureProject);
  });
});
