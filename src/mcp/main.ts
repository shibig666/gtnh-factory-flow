import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { PlannerApi } from "@/lib/agent/data-client";
import { createAgentConnection } from "@/lib/agent/create-connection";
import type { ConnectionMode } from "@/lib/agent/connection";
import { createMcpServer } from "./server";
import { PlannerTransport } from "@/lib/agent/planner-transport";

async function main() {
  const transport = new PlannerTransport(
    process.env.GTNH_PLANNER_URL ?? "http://localhost:3000",
    (warning) => console.error(`[gtnh] ${warning.message}`),
  );
  const api = new PlannerApi(transport.origin, transport.request, () => transport.warnings());
  const mode = process.env.GTNH_AGENT_TRANSPORT ?? "auto";
  if (!["auto", "local", "relay"].includes(mode))
    throw new Error("GTNH_AGENT_TRANSPORT must be auto, local or relay.");
  const bridge = createAgentConnection(api.baseUrl, mode as ConnectionMode, transport);
  await bridge.start();
  const stdio = serveStdio(() => createMcpServer(api, bridge), {
    onerror: (error) => console.error(error.message),
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await bridge.close();
    await stdio.close();
  }
  process.stdin.on("end", () => {
    void close();
  });
  process.on("SIGINT", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
