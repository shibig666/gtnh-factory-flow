import { BrowserBridge } from "./bridge";
import { RelayConnection } from "./relay-connection";
import { connectionMode, type AgentConnection, type ConnectionMode } from "./connection";

export function createAgentConnection(
  origin: string,
  mode: ConnectionMode = "auto",
): AgentConnection {
  return connectionMode(origin, mode) === "relay"
    ? new RelayConnection(origin)
    : new BrowserBridge(origin);
}
