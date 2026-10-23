import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  AgentError,
  browserCommandSchema,
  errorResult,
  type BrowserCommand,
} from "@/lib/agent/protocol";
import {
  RELAY_PROTOCOL,
  RELAY_SOCKET_PATH,
  RELAY_PAIRING_PREFIX,
  browserStatusSchema,
  relayApprovalSchema,
  type RelayGrant,
  type RelayStatus,
} from "@/lib/agent/relay-protocol";

const MAX_FRAME = 3_950_000;
const secret = () => randomBytes(32).toString("hex");
const hash = (value: string) => createHash("sha256").update(value).digest();
const matches = (value: unknown, expected: Buffer) =>
  typeof value === "string" && value.length <= 512 && timingSafeEqual(hash(value), expected);
const MUTATIONS = new Set([
  "create_design",
  "open_design",
  "apply_design_actions",
  "arrange_design",
  "undo_design",
  "redo_design",
]);
type Pending = {
  command: BrowserCommand;
  serialized: string;
  timer: ReturnType<typeof setTimeout>;
};
interface Room {
  id: string;
  codeHash: Buffer;
  deviceHash: Buffer;
  browserHash?: Buffer;
  expires: number;
  grant?: RelayGrant;
  status?: RelayStatus;
  agent?: WebSocket;
  browser?: WebSocket;
  pending: Map<string, Pending>;
  receipts: Map<string, { serialized: string; result?: unknown }>;
}
export interface RelayOptions {
  origin: string;
  maxRooms?: number;
  pairingTtlMs?: number;
  grantTtlMs?: number;
  proxyToken?: string;
}

/** A relay grants one browser session's selected designs, never a user's whole library. */
export class AgentRelayService {
  readonly origin: string;
  private readonly rooms = new Map<string, Room>();
  private readonly rates = new Map<string, { start: number; count: number }>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  private readonly http = createServer((request, response) => {
    void this.handle(request, response);
  });
  private sweep?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private readonly options: RelayOptions) {
    const url = new URL(options.origin);
    if (
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Agent relay origin must use HTTPS, or HTTP on loopback for development.");
    this.origin = url.origin;
    if (
      !Number.isInteger(options.maxRooms ?? 100) ||
      (options.maxRooms ?? 100) < 1 ||
      (options.maxRooms ?? 100) > 10_000
    )
      throw new Error("Relay room limit must be an integer from 1 to 10000.");
    this.http.on("upgrade", (request, socket, head) => {
      if (
        this.stopping ||
        request.url !== RELAY_SOCKET_PATH ||
        this.wss.clients.size >= (options.maxRooms ?? 100) * 2 + 64 ||
        (request.headers.origin && request.headers.origin !== this.origin) ||
        !this.admit(request, "socket", 300)
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.accept(ws, request.headers.origin),
      );
    });
  }

  private admit(request: IncomingMessage, operation: string, maximum: number) {
    const trusted =
      this.options.proxyToken && request.headers["x-agent-proxy-token"] === this.options.proxyToken;
    const address = trusted
      ? String(request.headers["x-agent-client-ip"] ?? "proxy")
      : (request.socket.remoteAddress ?? "unknown");
    const key = `${operation}:${address.slice(0, 200)}`;
    const now = Date.now();
    const entry = this.rates.get(key);
    if (!entry || now - entry.start > 60_000) {
      if (!entry && this.rates.size >= 4096) return false;
      this.rates.set(key, { start: now, count: 1 });
      return true;
    }
    return ++entry.count <= maximum;
  }

  private reply(response: ServerResponse, status: number, value: unknown) {
    if (response.destroyed) return;
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      if (request.method === "GET" && request.url === "/health")
        return this.reply(response, 200, { ok: true, protocol: RELAY_PROTOCOL });
      if (
        request.method !== "POST" ||
        !["/api/agent/pairings", "/api/agent/approve", "/api/agent/revoke"].includes(
          request.url ?? "",
        )
      )
        return this.reply(response, 404, {
          error: { code: "NOT_FOUND", message: "Unknown relay route." },
        });
      if (!this.admit(request, "http", 120))
        return this.reply(response, 429, {
          error: { code: "RATE_LIMIT", message: "Try again later." },
        });
      if (request.headers.origin && request.headers.origin !== this.origin)
        throw new AgentError("ORIGIN_MISMATCH", "Use the configured planner origin.");
      if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
        throw new AgentError("INVALID_REQUEST", "Use application/json.");
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 16_384)
          throw new AgentError("TOO_LARGE", "Pairing request is too large.");
      }
      const data: unknown = JSON.parse(body);
      if (request.url === "/api/agent/pairings") {
        if (!this.admit(request, "pair", 6))
          return this.reply(response, 429, {
            error: { code: "RATE_LIMIT", message: "Too many pairings. Try again later." },
          });
        z.object({ v: z.literal(RELAY_PROTOCOL) })
          .strict()
          .parse(data);
        if (this.stopping || this.rooms.size >= (this.options.maxRooms ?? 100))
          throw new AgentError("BUSY", "Relay capacity reached.");
        const userCode = [...randomBytes(12)]
          .map((n) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[n & 31])
          .join("");
        const token = secret();
        const id = randomUUID();
        const expires = Date.now() + (this.options.pairingTtlMs ?? 600_000);
        this.rooms.set(id, {
          id,
          codeHash: hash(userCode),
          deviceHash: hash(token),
          expires,
          pending: new Map(),
          receipts: new Map(),
        });
        const code =
          RELAY_PAIRING_PREFIX +
          Buffer.from(
            JSON.stringify({ v: RELAY_PROTOCOL, origin: this.origin, pairingId: id, userCode }),
          ).toString("base64url");
        return this.reply(response, 201, {
          pairingId: id,
          deviceToken: token,
          code,
          expiresAt: expires,
          plannerUrl: this.origin,
          transport: "relay",
        });
      }
      if (request.url === "/api/agent/approve") {
        if (!this.admit(request, "approve", 20))
          return this.reply(response, 429, {
            error: { code: "RATE_LIMIT", message: "Too many pairing attempts. Try again later." },
          });
        if (request.headers.origin !== this.origin)
          throw new AgentError("ORIGIN_MISMATCH", "Approve pairing from the planner webpage.");
        const approval = relayApprovalSchema.parse(data);
        const room = this.getRoom(approval.pairingId);
        if (!matches(approval.userCode, room.codeHash))
          throw new AgentError("PAIRING_REFUSED", "Pairing code is invalid or expired.");
        if (room.grant)
          throw new AgentError(
            "PAIRING_REFUSED",
            "This code has already been used. Request another code.",
          );
        if ((!approval.status.designId && !approval.allowCreate) || approval.status.readOnly)
          throw new AgentError(
            "PERMISSION_DENIED",
            "Open an editable design or allow new designs.",
          );
        const browserToken = secret();
        room.browserHash = hash(browserToken);
        room.expires = Date.now() + (this.options.grantTtlMs ?? 12 * 60 * 60_000);
        room.status = approval.status;
        room.grant = {
          pairingId: room.id,
          sessionId: approval.status.sessionId,
          designIds: approval.status.designId ? [approval.status.designId] : [],
          allowCreate: approval.allowCreate,
          expiresAt: room.expires,
        };
        return this.reply(response, 200, { browserToken, grant: room.grant });
      }
      const { pairingId } = z
        .object({ pairingId: z.string().max(512) })
        .strict()
        .parse(data);
      const room = this.getRoom(pairingId);
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (
        !matches(bearer, room.deviceHash) &&
        !(room.browserHash && matches(bearer, room.browserHash))
      )
        throw new AgentError("PERMISSION_DENIED", "Invalid connection credential.");
      this.revoke(room);
      return this.reply(response, 200, { revoked: true });
    } catch (error) {
      const formatted = errorResult(error);
      this.reply(
        response,
        formatted.code === "NOT_FOUND" ? 404 : formatted.code === "BUSY" ? 503 : 400,
        { error: formatted },
      );
    }
  }

  private getRoom(id: string) {
    const room = this.rooms.get(id);
    if (!room || room.expires <= Date.now()) {
      if (room) this.revoke(room);
      throw new AgentError("NOT_FOUND", "Pairing expired or revoked. Request a new code.");
    }
    return room;
  }

  private send(ws: WebSocket | undefined, value: unknown) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 8_000_000) {
      ws.terminate();
      return;
    }
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FRAME) {
      ws.close(1009, "Response too large");
      return;
    }
    ws.send(text);
  }

  private publish(room: Room) {
    this.send(room.agent, {
      t: "status",
      connected: room.browser?.readyState === WebSocket.OPEN,
      browser: room.status,
      grant: room.grant,
    });
  }

  private failPending(room: Room) {
    for (const [requestId, pending] of room.pending) {
      clearTimeout(pending.timer);
      this.send(room.agent, {
        t: "result",
        requestId,
        result: {
          ok: false,
          error: {
            code: "OUTCOME_UNKNOWN",
            message: "Connection interrupted. Read the design before another edit.",
          },
        },
      });
    }
    room.pending.clear();
  }

  private revoke(room: Room) {
    this.failPending(room);
    this.rooms.delete(room.id);
    room.agent?.close(4001, "Pairing revoked");
    room.browser?.close(4001, "Pairing revoked");
  }

  private accept(ws: WebSocket, origin: string | undefined) {
    let room: Room | undefined;
    let role: "agent" | "browser" | undefined;
    let alive = true;
    const authTimer = setTimeout(() => ws.close(1008, "Authenticate first"), 5000);
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw) => {
      try {
        const payload = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        const message = JSON.parse(payload.toString());
        if (!room) {
          if (payload.byteLength > 8192)
            throw new AgentError("TOO_LARGE", "Authentication too large.");
          const hello = z
            .object({
              t: z.literal("hello"),
              v: z.literal(RELAY_PROTOCOL),
              pairingId: z.string().max(512),
              token: z.string().max(512),
              role: z.enum(["agent", "browser"]),
            })
            .strict()
            .parse(message);
          const selected = this.getRoom(hello.pairingId);
          if (
            hello.role === "agent"
              ? !matches(hello.token, selected.deviceHash)
              : origin !== this.origin ||
                !selected.browserHash ||
                !matches(hello.token, selected.browserHash)
          )
            throw new AgentError("PERMISSION_DENIED", "Authentication refused.");
          room = selected;
          role = hello.role;
          if (room[role]) {
            this.failPending(room);
            room[role]?.terminate();
          }
          room[role] = ws;
          clearTimeout(authTimer);
          this.send(ws, { t: "ready", grant: room.grant });
          this.publish(room);
          return;
        }
        if (room.expires <= Date.now() || !this.rooms.has(room.id)) {
          this.revoke(room);
          return;
        }
        if (room[role!] !== ws) return;
        if (role === "agent") {
          if (message.t !== "command")
            throw new AgentError("INVALID_REQUEST", "Expected a command.");
          if (payload.byteLength > 512 * 1024)
            throw new AgentError("TOO_LARGE", "Split the command into smaller batches.");
          const command = browserCommandSchema.parse(message.command);
          try {
            this.forward(room, command);
          } catch (error) {
            this.send(ws, {
              t: "result",
              requestId: command.requestId,
              result: { ok: false, error: errorResult(error) },
            });
          }
          return;
        }
        if (message.t === "status") {
          const status = browserStatusSchema.parse(message.status);
          this.checkStatus(room, status);
          room.status = status;
          this.publish(room);
        } else if (message.t === "result" && typeof message.requestId === "string") {
          const pending = room.pending.get(message.requestId);
          if (!pending) return;
          const result = z
            .object({
              ok: z.boolean(),
              value: z.unknown().optional(),
              error: z.unknown().optional(),
              status: browserStatusSchema.optional(),
            })
            .parse(message.result);
          if (result.ok && pending.command.method === "create_design") {
            const created = browserStatusSchema.parse(result.value);
            if (
              created.sessionId !== room.grant!.sessionId ||
              !created.designId ||
              !room.grant!.allowCreate ||
              room.grant!.designIds.length >= 100
            )
              throw new AgentError("PERMISSION_DENIED", "New design is outside this grant.");
            if (!room.grant!.designIds.includes(created.designId))
              room.grant!.designIds.push(created.designId);
          }
          if (result.status) {
            this.checkStatus(room, result.status);
            room.status = result.status;
          }
          clearTimeout(pending.timer);
          room.pending.delete(message.requestId);
          if (MUTATIONS.has(pending.command.method)) {
            room.receipts.set(message.requestId, {
              serialized: pending.serialized,
              result: payload.byteLength < 8192 ? result : undefined,
            });
            if (room.receipts.size > 128) room.receipts.delete(room.receipts.keys().next().value!);
          }
          this.send(room.agent, { t: "result", requestId: message.requestId, result });
          this.publish(room);
        } else throw new AgentError("INVALID_REQUEST", "Unexpected browser frame.");
      } catch {
        ws.close(1008, "Invalid or unauthorized frame");
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (room && role && room[role] === ws) {
        room[role] = undefined;
        this.failPending(room);
        this.publish(room);
      }
    });
  }

  private checkStatus(room: Room, status: RelayStatus) {
    if (
      !room.grant ||
      status.sessionId !== room.grant.sessionId ||
      (status.designId && !room.grant.designIds.includes(status.designId))
    )
      throw new AgentError("PERMISSION_DENIED", "Browser switched outside the authorized designs.");
  }

  private forward(room: Room, command: BrowserCommand) {
    if (!room.grant || room.browser?.readyState !== WebSocket.OPEN)
      throw new AgentError(
        "BROWSER_DISCONNECTED",
        "Approve the pairing and keep the webpage open.",
      );
    const { args, method, requestId } = command;
    if (
      method === "create_design" &&
      (!room.grant.allowCreate || room.grant.designIds.length >= 100)
    )
      throw new AgentError(
        "PERMISSION_DENIED",
        "New designs were not authorized, or the grant is full.",
      );
    if (args.sessionId !== undefined && args.sessionId !== room.grant.sessionId)
      throw new AgentError("SESSION_CHANGED", "Read the paired session again.");
    if (args.designId !== undefined && !room.grant.designIds.includes(String(args.designId)))
      throw new AgentError("PERMISSION_DENIED", "This design was not authorized.");
    const serialized = hash(JSON.stringify(command)).toString("hex");
    const previous = room.receipts.get(requestId);
    if (previous) {
      if (previous.serialized !== serialized)
        throw new AgentError("REQUEST_ID_REUSED", "Use a new request ID for different arguments.");
      if (!previous.result)
        throw new AgentError(
          "OUTCOME_UNKNOWN",
          "Read the design; the previous result is no longer available.",
        );
      this.send(room.agent, { t: "result", requestId, result: previous.result });
      return;
    }
    if (room.pending.has(requestId) || room.pending.size >= 8)
      throw new AgentError("BUSY", "Wait for the pending command.");
    // Reserve mutation IDs before forwarding. A lost acknowledgement must never trigger replay.
    if (MUTATIONS.has(method)) {
      room.receipts.set(requestId, { serialized });
      if (room.receipts.size > 128) room.receipts.delete(room.receipts.keys().next().value!);
    }
    const timer = setTimeout(() => {
      room.pending.delete(requestId);
      this.send(room.agent, {
        t: "result",
        requestId,
        result: {
          ok: false,
          error: {
            code: "OUTCOME_UNKNOWN",
            message: "No browser acknowledgement. Inspect the design before another edit.",
          },
        },
      });
    }, 60_000);
    room.pending.set(requestId, { command, serialized, timer });
    this.send(room.browser, { t: "command", command });
  }

  async start(port = 3002, host = "127.0.0.1") {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    this.sweep = setInterval(() => {
      for (const room of this.rooms.values()) if (room.expires <= Date.now()) this.revoke(room);
      for (const [key, entry] of this.rates)
        if (Date.now() - entry.start > 60_000) this.rates.delete(key);
    }, 30_000);
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("No relay listener.");
    return address.port;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.sweep);
    for (const room of this.rooms.values()) this.revoke(room);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
