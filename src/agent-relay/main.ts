import { AgentRelayService } from "./service";
import { httpWarning } from "@/lib/agent/connection-security";

async function main() {
  const origin = process.env.AGENT_PUBLIC_ORIGIN;
  if (!origin) throw new Error("Set AGENT_PUBLIC_ORIGIN to the planner's public HTTP(S) origin.");
  const warning = httpWarning(origin);
  if (warning) console.warn(`[agent-relay] ${warning.message}`);
  const relay = new AgentRelayService({
    origin,
    proxyToken: process.env.AGENT_RELAY_PROXY_TOKEN,
    maxRooms: Number(process.env.AGENT_RELAY_MAX_ROOMS ?? 100),
  });
  const port = await relay.start(
    Number(process.env.AGENT_RELAY_PORT ?? 3002),
    process.env.AGENT_RELAY_HOST ?? "127.0.0.1",
  );
  console.log(`[agent-relay] listening on ${port} for ${origin}`);
  const stop = () => {
    void relay.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Relay startup failed.");
  process.exitCode = 1;
});
