import { describe, expect, it, vi } from "vitest";
import { PlannerApi, compactData, recipeView } from "./data-client";
import { fixtureRecipes } from "./__fixtures__/chain";

describe("planner API adapter", () => {
  it("accepts server-advertised dataset versions and rejects unadvertised identifiers", async () => {
    const api = new PlannerApi("https://planner.example.com", async () =>
      Response.json({
        versions: [{ id: "server-next", gtnhVersion: "2.10", checksumSha256: "next-hash" }],
      }),
    );
    await expect(api.identity("server-next")).resolves.toEqual({
      versionId: "server-next",
      fingerprint: "next-hash",
    });
    await expect(api.identity("unadvertised")).rejects.toThrow("configured planner");
  });
  it("queries only the configured HTTP origin, encodes ids and has no file fallback", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(fixtureRecipes[0]));
    const api = new PlannerApi("http://localhost:3000", request);
    await api.recipe("local-2.9", "fixture:smelt");
    expect(String(request.mock.calls[0][0])).toBe(
      "http://localhost:3000/api/datasets/local-2.9/recipes/fixture%3Asmelt",
    );
    expect(() => new PlannerApi("file:///somewhere")).toThrow();
    const unavailable = new PlannerApi("https://example.com", async () => {
      throw new Error("offline");
    });
    await expect(unavailable.manifest()).rejects.toThrow(/No local dataset fallback/);
  });
  it("keeps chances, alternatives, kept inputs and unknown gameplay metadata", () => {
    const recipe = {
      ...fixtureRecipes[0],
      inputs: [
        {
          ...fixtureRecipes[0].inputs[0],
          consumed: false,
          alternatives: [{ kind: "item" as const, id: "fixture:alternate", amount: 2 }],
        },
      ],
      outputs: [{ ...fixtureRecipes[0].outputs[0], chance: 0.25 }],
      metadata: { unrecognizedGate: { value: 42 } },
    };
    const compact = recipeView(recipe) as typeof recipe;
    expect(compact.inputs[0].consumed).toBe(false);
    expect(compact.inputs[0].alternatives).toEqual(recipe.inputs[0].alternatives);
    expect(compact.outputs[0].chance).toBe(0.25);
    expect(compact.metadata).toEqual(recipe.metadata);
    expect(compactData({ iconPath: "large", nei: { slots: [] }, amount: 12 })).toEqual({
      amount: 12,
    });
    expect(recipeView(recipe, "full")).toBe(recipe);
  });
  it("preserves all returned paging metadata and serializes multi-condition queries", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ recipes: [], total: 241, offset: 20, limit: 20, hasMore: true }),
    );
    const result = await new PlannerApi("http://localhost:3000", request).recipes("v", {
      offset: 20,
      limit: 20,
      clause: ["makes:item:test:a", "takes:fluid:test:b"],
    });
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.searchParams.getAll("clause")).toEqual(["makes:item:test:a", "takes:fluid:test:b"]);
    expect(url.searchParams.get("allMaps")).toBe("1");
    expect(result.total).toBe(241);
    expect(result.hasMore).toBe(true);
  });
});
