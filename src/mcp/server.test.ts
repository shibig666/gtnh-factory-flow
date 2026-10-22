import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixtureRecipes } from "@/lib/agent/__fixtures__/chain";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixtureApi() {
  const server: Server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.includes("manifest"))
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          latestStableVersion: "fixture",
          versions: [
            {
              id: "fixture",
              gtnhVersion: "2.9",
              publishedAt: "fixture",
              checksumSha256: "fixture-hash",
              sourceInfo: { generatedAt: "fixture" },
            },
          ],
        }),
      );
    else if (request.url?.includes("/recipes/")) response.end(JSON.stringify(fixtureRecipes[0]));
    else
      response.end(
        JSON.stringify({ recipes: fixtureRecipes, total: 2, offset: 0, limit: 20, hasMore: false }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

describe("MCP over actual stdio", () => {
  it("discovers typed tools and queries the configured HTTP API", async () => {
    const origin = await fixtureApi();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/main.ts"],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), GTNH_PLANNER_URL: origin },
      stderr: "pipe",
    });
    const client = new Client({ name: "gtnh-protocol-test", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(transport);
    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "search_recipes",
        "get_recipes",
        "apply_design_actions",
        "evaluate_design",
      ]),
    );
    const datasets = await client.callTool({ name: "list_datasets", arguments: {} });
    expect(datasets.isError).toBeFalsy();
    expect(datasets.structuredContent).toMatchObject({ latestStableVersion: "fixture" });
    const recipes = await client.callTool({
      name: "get_recipes",
      arguments: { versionId: "fixture", recipeIds: ["fixture:smelt"] },
    });
    expect(recipes.isError).toBeFalsy();
    expect(recipes.structuredContent).toMatchObject({
      dataset: { versionId: "fixture", fingerprint: "fixture-hash" },
    });
    const unpaired = await client.callTool({ name: "list_designs", arguments: {} });
    expect(unpaired.isError).toBe(true);
    expect(unpaired.structuredContent).toMatchObject({ error: { code: "BROWSER_DISCONNECTED" } });
  }, 30_000);
});
