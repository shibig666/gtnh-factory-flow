import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PlannerApi } from "@/lib/agent/data-client";
import { errorResult } from "@/lib/agent/protocol";
import { createPlannerTools } from "@/lib/agent/tools";
import type { AgentConnection } from "@/lib/agent/connection";
import {
  CONNECTION_GUIDANCE,
  IMAGE_GUIDANCE,
  SERVER_SETTINGS_GUIDANCE,
} from "@/lib/agent/guidance";
import { isDesignImage, imageMetadata } from "@/lib/agent/image-protocol";

export function createMcpServer(api: PlannerApi, bridge: AgentConnection) {
  const server = new McpServer(
    { name: "gtnh-factory-flow", version: "1.2.0" },
    {
      instructions:
        CONNECTION_GUIDANCE +
        " " +
        SERVER_SETTINGS_GUIDANCE +
        " " +
        IMAGE_GUIDANCE +
        " Query recipes through the configured planner HTTP API. Read get_status/get_design before editing; copy its session, revision and dataset fingerprint. Batches are atomic and undoable. Ask for target rates, max tier and external inputs. Solve success alone does not prove completion: use evaluate_design with all task constraints. Recipe IDs are authoritative; recipes are read-only.",
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
          if (isDesignImage(result)) {
            const metadata = imageMetadata(result);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(metadata) },
                { type: "image" as const, mimeType: "image/png", data: result.data },
              ],
              structuredContent: metadata,
            };
          }
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
