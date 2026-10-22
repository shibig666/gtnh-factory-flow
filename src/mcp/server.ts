import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PlannerApi } from "@/lib/agent/data-client";
import { errorResult } from "@/lib/agent/protocol";
import { createPlannerTools } from "@/lib/agent/tools";
import type { BrowserBridge } from "./bridge";

export function createMcpServer(api: PlannerApi, bridge: BrowserBridge) {
  const server = new McpServer(
    { name: "gtnh-factory-flow", version: "1.0.0" },
    {
      instructions:
        "Query recipes through the configured planner HTTP API. Pair a local webpage for edits. Read get_status/get_design before editing; copy its session, revision and dataset fingerprint. Batches are atomic and undoable. Never retry an unknown write without inspecting the design. Ask for target rates, max tier and external inputs. Solve success alone does not prove completion: use evaluate_design with all task constraints. Recipe IDs are authoritative; recipes are read-only.",
    },
  );
  for (const tool of createPlannerTools(api, bridge)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema as z.ZodObject<z.ZodRawShape>,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          idempotentHint: tool.readOnly,
          openWorldHint: true,
        },
      },
      async (raw) => {
        try {
          const result = await tool.run(raw);
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
  return server;
}
