import { BrowserBridge } from "./bridge";
import { RelayConnection } from "./relay-connection";
import { connectionMode, type AgentConnection, type ConnectionMode } from "./connection";
import type { PlannerTransport } from "./planner-transport";

export function createAgentConnection(
  origin: string,
  mode: ConnectionMode = "auto",
  transport?: PlannerTransport,
): AgentConnection {
  return connectionMode(origin, mode) === "relay"
    ? new RelayConnection(origin, transport)
    : new BrowserBridge(origin);
}
