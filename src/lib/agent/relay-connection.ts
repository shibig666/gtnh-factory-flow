import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { AgentError, type BrowserCommand } from "./protocol";
import type { AgentConnection } from "./connection";
import {
  RELAY_PROTOCOL,
  browserStatusSchema,
  relayGrantSchema,
  relaySocketUrl,
  type RelayGrant,
  type RelayStatus,
} from "./relay-protocol";

/** Outbound-only transport shared by MCP and the native DSH plugin. */
export class RelayConnection implements AgentConnection {
  private socket?: WebSocket;
  private pairing?: { id: string; token: string };
  private browser?: RelayStatus;
  private grant?: RelayGrant;
  private connected = false;
  private closed = false;
  private pairingInProgress = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; cleanup: () => void }
  >();

  constructor(readonly plannerUrl: string) {
    const url = new URL(plannerUrl);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("Remote agent connections require HTTPS.");
  }

  async start() {
    /* Connections are initiated on pairing; public recipe queries need no grant. */
  }

  status() {
    return {
      connected: this.connected,
      plannerUrl: this.plannerUrl,
      transport: "relay",
      browser: this.browser,
      grant: this.grant,
    };
  }

  async beginPairing() {
    if (this.closed) throw new AgentError("CLOSED", "The connection has been disposed.");
    if (this.pending.size || this.pairingInProgress)
      throw new AgentError("BUSY", "Wait for the pending command or pairing.");
    this.pairingInProgress = true;
    try {
      await this.reset();
      const response = await fetch(new URL("/api/agent/pairings", this.plannerUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: RELAY_PROTOCOL }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      const result = await response.json();
      if (!response.ok)
        throw new AgentError(
          "RELAY_UNAVAILABLE",
          "The planner's agent relay is unavailable. Check its deployment.",
        );
      const created = z
        .object({
          pairingId: z.string(),
          deviceToken: z.string().min(32),
          code: z.string(),
          expiresAt: z.number(),
          plannerUrl: z.string(),
        })
        .parse(result);
      if (created.plannerUrl !== this.plannerUrl)
        throw new AgentError(
          "ORIGIN_MISMATCH",
          "The relay is configured for another planner origin.",
        );
      this.pairing = { id: created.pairingId, token: created.deviceToken };
      if (this.closed) {
        await this.reset();
        throw new AgentError("CLOSED", "The connection has been disposed.");
      }
      try {
        await this.connect();
      } catch (error) {
        await this.reset();
        throw error;
      }
      return {
        code: created.code,
        expiresAt: new Date(created.expiresAt).toISOString(),
        plannerUrl: this.plannerUrl,
        transport: "relay",
        instructions:
          "Open Settings > Agent on this planner. Approve the current design; enable new designs only if needed. Keep the webpage open. No local port is required.",
      };
    } finally {
      this.pairingInProgress = false;
    }
  }

  private async connect() {
    const pairing = this.pairing;
    if (!pairing || this.closed) return;
    const ws = new WebSocket(relaySocketUrl(this.plannerUrl), { maxPayload: 4 * 1024 * 1024 });
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new AgentError("RELAY_UNAVAILABLE", "Relay connection timed out."));
      }, 10_000);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            t: "hello",
            v: RELAY_PROTOCOL,
            role: "agent",
            pairingId: pairing.id,
            token: pairing.token,
          }),
        ),
      );
      ws.on("message", (raw) => {
        if (this.socket !== ws) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.t === "ready") {
            ready = true;
            clearTimeout(timeout);
            this.grant = message.grant ? relayGrantSchema.parse(message.grant) : undefined;
            resolve();
          } else if (message.t === "status") {
            this.connected = message.connected === true;
            this.browser = message.browser ? browserStatusSchema.parse(message.browser) : undefined;
            this.grant = message.grant ? relayGrantSchema.parse(message.grant) : undefined;
          } else if (message.t === "result" && typeof message.requestId === "string") {
            const request = this.pending.get(message.requestId);
            if (!request) return;
            request.cleanup();
            this.pending.delete(message.requestId);
            if (message.result?.status)
              this.browser = browserStatusSchema.parse(message.result.status);
            request.resolve(message.result);
          }
        } catch {
          ws.close(1008, "Invalid relay message");
        }
      });
      ws.on("error", () => {
        if (!ready)
          reject(new AgentError("RELAY_UNAVAILABLE", "Could not connect to the planner relay."));
      });
      ws.on("close", (code) => {
        clearTimeout(timeout);
        if (!ready)
          reject(new AgentError("PAIRING_REFUSED", "Relay pairing expired or was revoked."));
        if (this.socket !== ws) return;
        this.socket = undefined;
        this.connected = false;
        this.failPending();
        if (!this.closed && this.pairing === pairing && code !== 4001 && code !== 1008) {
          this.reconnect = setTimeout(() => {
            void this.connect().catch(() => undefined);
          }, 1500);
        }
      });
    });
  }

  call(
    method: BrowserCommand["method"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN)
      throw new AgentError(
        "BROWSER_DISCONNECTED",
        "Pair a design and keep its webpage open. Re-read status after reconnecting.",
      );
    const requestId = typeof args.requestId === "string" ? args.requestId : randomUUID();
    if (this.pending.has(requestId) || this.pending.size >= 8)
      throw new AgentError("BUSY", "Wait for pending commands.");
    const payload = JSON.stringify({ t: "command", command: { method, requestId, args } });
    if (Buffer.byteLength(payload) > 512 * 1024)
      throw new AgentError("TOO_LARGE", "Split the command into smaller batches.");
    return new Promise((resolve, reject) => {
      const interrupted = () => {
        cleanup();
        this.pending.delete(requestId);
        reject(
          new AgentError(
            "OUTCOME_UNKNOWN",
            "The command was interrupted. Inspect the design before another edit.",
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", interrupted);
      };
      const timer = setTimeout(interrupted, 65_000);
      this.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", interrupted, { once: true });
      if (signal?.aborted) {
        interrupted();
        return;
      }
      this.socket!.send(payload);
    });
  }

  private failPending() {
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(
        new AgentError(
          "OUTCOME_UNKNOWN",
          "Relay connection was lost. Inspect the design before another edit.",
        ),
      );
    }
    this.pending.clear();
  }

  private async reset() {
    clearTimeout(this.reconnect);
    const previous = this.pairing;
    this.pairing = undefined;
    const ws = this.socket;
    this.socket = undefined;
    ws?.close();
    this.connected = false;
    this.browser = undefined;
    this.grant = undefined;
    this.failPending();
    if (previous)
      await fetch(new URL("/api/agent/revoke", this.plannerUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${previous.token}` },
        body: JSON.stringify({ pairingId: previous.id }),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      }).catch(() => undefined);
  }

  async close() {
    this.closed = true;
    await this.reset();
  }
}
