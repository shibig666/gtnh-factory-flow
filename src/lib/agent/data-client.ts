import type { DatasetManifest, DatasetVersion, RecipeSummary } from "@/lib/datasets/types";
import { recipeSchema } from "@/lib/model/schemas";
import type { Recipe } from "@/lib/model/types";
import { AgentError, type DatasetIdentity } from "./protocol";

const VISUAL_KEYS = new Set(["iconPath", "iconAtlas", "dominantColor", "tooltip", "nei"]);

/** Keep unknown gameplay metadata; only presentation fields have a safe omission rule. */
export function compactData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VISUAL_KEYS.has(key))
      .map(([key, entry]) => [key, compactData(entry)]),
  );
}

export function recipeView(
  recipe: Recipe | RecipeSummary,
  detail: "summary" | "planning" | "full" = "planning",
) {
  if (detail === "full") return recipe;
  if (detail === "summary") {
    const slot = (entry: Recipe["inputs"][number]) => ({
      kind: entry.kind,
      id: entry.id,
      displayName: entry.displayName,
      amount: entry.amount,
      consumed: entry.consumed,
      chance: "chance" in entry ? entry.chance : undefined,
      alternativeCount: entry.alternatives?.length ?? 0,
    });
    return {
      id: recipe.id,
      name: recipe.name,
      machineType: recipe.machineType,
      recipeMap:
        "recipeMap" in recipe ? recipe.recipeMap : (recipe.source?.recipeMap ?? recipe.machineType),
      minimumTier: recipe.minimumTier,
      durationTicks: recipe.durationTicks,
      eut: recipe.eut,
      inputs: recipe.inputs.map(slot),
      outputs: recipe.outputs.map(slot),
    };
  }
  const { runtimeCalculation, ...planning } = recipe as Recipe;
  return compactData({ ...planning, hasRuntimeCalculation: Boolean(runtimeCalculation) });
}

export function datasetIdentity(version: DatasetVersion): DatasetIdentity {
  return {
    versionId: version.id,
    fingerprint:
      version.checksumSha256 ??
      `${version.id}:${version.publishedAt}:${version.sourceInfo.generatedAt}`,
  };
}

export class PlannerApi {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new AgentError(
        "BAD_API_URL",
        "Use the planner's HTTP origin, without a path or credentials.",
      );
    this.baseUrl = url.origin;
  }

  async json<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined | string[]> = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry));
      else if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await this.request(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      throw new AgentError(
        "DATA_UNAVAILABLE",
        "The planner API could not be reached. No local dataset fallback was used.",
      );
    }
    if (!response.ok)
      throw new AgentError(
        response.status === 404 ? "NOT_FOUND" : "DATA_UNAVAILABLE",
        `Planner API returned ${response.status} for ${url.pathname}.`,
      );
    return response.json() as Promise<T>;
  }

  manifest() {
    return this.json<DatasetManifest>("/datasets/gtnh/datasets.manifest.json");
  }
  async identity(versionId: string) {
    const version = (await this.manifest()).versions.find((entry) => entry.id === versionId);
    if (!version)
      throw new AgentError(
        "DATASET_UNAVAILABLE",
        "Choose a dataset available on the configured planner.",
      );
    return datasetIdentity(version);
  }
  catalog(versionId: string) {
    return this.json<Record<string, unknown>>(
      `/api/datasets/${encodeURIComponent(versionId)}/catalog`,
    );
  }
  resources(versionId: string, query: Record<string, string | number | undefined>) {
    return this.json<{
      resources: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    }>(`/api/datasets/${encodeURIComponent(versionId)}/resources`, query);
  }
  recipes(versionId: string, query: Record<string, string | number | undefined | string[]>) {
    return this.json<{
      recipes: RecipeSummary[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
      recipeMaps: string[];
    }>(`/api/datasets/${encodeURIComponent(versionId)}/recipes`, { ...query, allMaps: "1" });
  }
  async recipe(versionId: string, recipeId: string): Promise<Recipe> {
    const recipe = recipeSchema.parse(
      await this.json(
        `/api/datasets/${encodeURIComponent(versionId)}/recipes/${encodeURIComponent(recipeId)}`,
      ),
    ) as Recipe;
    if (recipe.id !== recipeId)
      throw new AgentError("DATA_MISMATCH", "The API returned a different recipe id.");
    return recipe;
  }
}
