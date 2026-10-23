import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { AGENT_PROTOCOL, AgentError, type BrowserCommand } from "@/lib/agent/protocol";

export class BrowserBridge {
  private readonly http = createServer((_, response) => {
    response.writeHead(404).end();
  });
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private peer?: WebSocket;
  private browserId?: string;
  private token = "";
  private expires = 0;
  private url = "";
  private browserStatus?: Record<string, unknown>;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  constructor(readonly apiBaseUrl: string) {}

  async start() {
    this.http.on("upgrade", (request, socket, head) => {
      if (
        request.headers.origin !== this.apiBaseUrl ||
        request.headers.host !== new URL(this.url).host ||
        request.url !== "/agent"
      ) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("No bridge address.");
    this.url = `ws://127.0.0.1:${address.port}/agent`;
  }

  beginPairing() {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(this.apiBaseUrl).hostname))
      throw new AgentError(
        "LOCAL_ONLY",
        "Canvas edits require a local planner instance. Set GTNH_PLANNER_URL to that instance; configure its GTNH_DATASET_BACKEND_URL for remote recipes.",
      );
    if (this.pending.size)
      throw new AgentError("BUSY", "Wait for active commands before pairing another browser tab.");
    this.peer?.close();
    this.peer = undefined;
    this.browserId = undefined;
    this.browserStatus = undefined;
    this.token = randomBytes(32).toString("hex");
    this.expires = Date.now() + 10 * 60_000;
    return {
      code: `gtnh-agent.${Buffer.from(JSON.stringify({ v: AGENT_PROTOCOL, url: this.url, token: this.token, apiBaseUrl: this.apiBaseUrl })).toString("base64url")}`,
      expiresAt: new Date(this.expires).toISOString(),
      plannerUrl: this.apiBaseUrl,
      transport: "local",
      instructions:
        "Open Settings > Agent on this planner URL and paste the pairing code. Pairing allows edits in this browser tab.",
    };
  }

  status() {
    return {
      connected: this.peer?.readyState === WebSocket.OPEN,
      transport: "local",
      plannerUrl: this.apiBaseUrl,
      browser: this.browserStatus,
    };
  }

  private accept(ws: WebSocket) {
    let authenticated = false;
    const timeout = setTimeout(() => ws.close(1008, "Authenticate first"), 5000);
    ws.on("error", () => ws.close());
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          const supplied =
            typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
          const expected = Buffer.from(this.token);
          if (
            !this.token ||
            message.t !== "hello" ||
            message.v !== AGENT_PROTOCOL ||
            message.apiBaseUrl !== this.apiBaseUrl ||
            typeof message.browserId !== "string" ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected) ||
            this.peer ||
            (this.browserId && this.browserId !== message.browserId) ||
            (!this.browserId && Date.now() > this.expires)
          ) {
            ws.close(1008, "Pairing refused");
            return;
          }
          authenticated = true;
          clearTimeout(timeout);
          this.peer = ws;
          this.browserId = message.browserId;
          this.browserStatus = message.status;
          ws.send(JSON.stringify({ t: "ready" }));
          return;
        }
        if (ws !== this.peer) return;
        if (message.t === "status") this.browserStatus = message.status;
        if (message.t === "result" && typeof message.requestId === "string") {
          const request = this.pending.get(message.requestId);
          if (!request) return;
          request.cleanup();
          this.pending.delete(message.requestId);
          if (message.result?.status) this.browserStatus = message.result.status;
          request.resolve(message.result);
        }
      } catch {
        ws.close(1008, "Invalid message");
      }
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (this.peer !== ws) return;
      this.peer = undefined;
      for (const request of this.pending.values()) {
        request.cleanup();
        request.reject(
          new AgentError(
            "OUTCOME_UNKNOWN",
            "The browser disconnected. Read its current design before retrying any edit; it may already have been saved.",
          ),
        );
      }
      this.pending.clear();
    });
  }

  call(method: BrowserCommand["method"], args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN)
      throw new AgentError(
        "BROWSER_DISCONNECTED",
        "Call begin_pairing and connect the local planner's Settings > Agent panel.",
      );
    const requestId = typeof args.requestId === "string" ? args.requestId : randomUUID();
    if (this.pending.has(requestId) || this.pending.size >= 8)
      throw new AgentError("BUSY", "Wait for the pending command.");
    const payload = JSON.stringify({ t: "command", command: { method, requestId, args } });
    if (Buffer.byteLength(payload) > 512 * 1024)
      throw new AgentError("TOO_LARGE", "Split this command into smaller batches.");
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        cleanup();
        reject(
          new AgentError(
            "OUTCOME_UNKNOWN",
            "The browser command was interrupted. Read the current design before another edit; it may already have been saved.",
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        reject(
          new AgentError(
            "OUTCOME_UNKNOWN",
            "The browser did not acknowledge this command in time. Read its current design before continuing.",
          ),
        );
      }, 60_000);
      this.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.peer!.send(payload);
    });
  }

  async close() {
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(new AgentError("CLOSED", "Agent bridge closed."));
    }
    this.pending.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
