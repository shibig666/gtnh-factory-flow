import type { BrowserCommand } from "./protocol";

/** Both adapters use the same connection contract; a remote connection never listens locally. */
export interface AgentConnection {
  start(): Promise<void>;
  status(): unknown;
  beginPairing(): unknown | Promise<unknown>;
  call(
    method: BrowserCommand["method"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type ConnectionMode = "auto" | "local" | "relay";

export function connectionMode(origin: string, mode: ConnectionMode = "auto"): "local" | "relay" {
  if (!["auto", "local", "relay"].includes(mode)) throw new Error("Unknown agent connection mode.");
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (mode === "local" && !loopback)
    throw new Error("Local connections require a loopback planner address.");
  if (mode !== "auto") return mode;
  return loopback && url.protocol === "http:" ? "local" : "relay";
}
