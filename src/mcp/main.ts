import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { PlannerApi } from "@/lib/agent/data-client";
import { createAgentConnection } from "@/lib/agent/create-connection";
import type { ConnectionMode } from "@/lib/agent/connection";
import { createMcpServer } from "./server";

async function main() {
  const api = new PlannerApi(process.env.GTNH_PLANNER_URL ?? "http://localhost:3000");
  const mode = process.env.GTNH_AGENT_TRANSPORT ?? "auto";
  if (!["auto", "local", "relay"].includes(mode))
    throw new Error("GTNH_AGENT_TRANSPORT must be auto, local or relay.");
  const bridge = createAgentConnection(api.baseUrl, mode as ConnectionMode);
  await bridge.start();
  const transport = serveStdio(() => createMcpServer(api, bridge), {
    onerror: (error) => console.error(error.message),
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await bridge.close();
    await transport.close();
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
