import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { AgentRelayService } from "./service";
import { RelayConnection } from "@/lib/agent/relay-connection";
import { RELAY_PAIRING_PREFIX } from "@/lib/agent/relay-protocol";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});
const status = {
  sessionId: "browser-session",
  revision: 1,
  designId: "authorized-design",
  readOnly: false,
};

async function start(options = {}) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const relay = new AgentRelayService({ origin, ...options });
  await relay.start(port);
  cleanup.push(() => relay.stop());
  const post = async (
    route: string,
    body: unknown,
    originHeader: string | null = origin,
    token?: string,
  ) => {
    const response = await fetch(`${origin}/api/agent/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(originHeader ? { Origin: originHeader } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { origin, relay, post };
}

async function socket(origin: string, hello: object, browserOrigin?: string) {
  const ws = new WebSocket(
    origin.replace("http:", "ws:") + "/agent/ws",
    browserOrigin ? { origin: browserOrigin } : undefined,
  );
  cleanup.push(async () => {
    ws.terminate();
  });
  const messages: {
    t: string;
    requestId: string;
    connected: boolean;
    command: { requestId: string };
    result: { error: { code: string }; value: { designId: string } };
  }[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "hello", v: 1, ...hello }));
  const next = async (type: string, requestId?: string) => {
    let found: number;
    await vi.waitFor(() => {
      found = messages.findIndex(
        (message) => message.t === type && (!requestId || message.requestId === requestId),
      );
      expect(found).toBeGreaterThanOrEqual(0);
    });
    return messages.splice(found!, 1)[0];
  };
  return { ws, next, messages };
}

async function paired(allowCreate = false) {
  const host = await start();
  const created = await host.post("pairings", { v: 1 }, null);
  const code = JSON.parse(
    Buffer.from(created.code.slice(RELAY_PAIRING_PREFIX.length), "base64url").toString(),
  );
  const approval = await host.post("approve", {
    pairingId: created.pairingId,
    userCode: code.userCode,
    status,
    allowCreate,
  });
  const agent = await socket(host.origin, {
    role: "agent",
    pairingId: created.pairingId,
    token: created.deviceToken,
  });
  await agent.next("ready");
  const browser = await socket(
    host.origin,
    { role: "browser", pairingId: created.pairingId, token: approval.browserToken },
    host.origin,
  );
  await browser.next("ready");
  await vi.waitFor(() =>
    expect(agent.messages.some((message) => message.t === "status" && message.connected)).toBe(
      true,
    ),
  );
  const send = (requestId: string, method = "get_design", args: object = {}) =>
    agent.ws.send(JSON.stringify({ t: "command", command: { requestId, method, args } }));
  return { ...host, created, code, approval, agent, browser, send };
}

describe("outbound planner relay", () => {
  it("issues one-use codes without private device credentials and enforces same-origin approval", async () => {
    const { post } = await start();
    const created = await post("pairings", { v: 1 }, null);
    const code = JSON.parse(
      Buffer.from(created.code.slice(RELAY_PAIRING_PREFIX.length), "base64url").toString(),
    );
    expect(code.deviceToken).toBeUndefined();
    expect(created.code).not.toContain(created.deviceToken);
    const body = { pairingId: created.pairingId, userCode: code.userCode, status };
    expect((await post("approve", body, "https://attacker.invalid")).error.code).toBe(
      "ORIGIN_MISMATCH",
    );
    expect((await post("approve", body, null)).error.code).toBe("ORIGIN_MISMATCH");
    expect(
      (await post("approve", { ...body, status: { ...status, readOnly: true } })).error.code,
    ).toBe("PERMISSION_DENIED");
    expect((await post("approve", body)).grant.designIds).toEqual([status.designId]);
    expect((await post("approve", body)).error.code).toBe("PAIRING_REFUSED");
  });

  it("isolates designs, sessions, new-design permission and role credentials", async () => {
    const pair = await paired();
    for (const [id, method, args, code] of [
      ["foreign", "get_design", { designId: "other-user" }, "PERMISSION_DENIED"],
      ["session", "get_design", { sessionId: "other-session" }, "SESSION_CHANGED"],
      ["create", "create_design", {}, "PERMISSION_DENIED"],
    ] as const) {
      pair.send(id, method, args);
      expect((await pair.agent.next("result", id)).result.error.code).toBe(code);
    }
    expect(pair.browser.messages.some((message) => message.t === "command")).toBe(false);
    const impostor = await socket(pair.origin, {
      role: "agent",
      pairingId: pair.created.pairingId,
      token: pair.approval.browserToken,
    });
    expect((await once(impostor.ws, "close"))[0]).toBe(1008);
    const stranger = await start();
    const other = await stranger.post("pairings", { v: 1 }, null);
    const cross = await socket(pair.origin, {
      role: "agent",
      pairingId: pair.created.pairingId,
      token: other.deviceToken,
    });
    expect((await once(cross.ws, "close"))[0]).toBe(1008);
  });

  it("forwards browser acknowledgements, deduplicates mutations and extends only permitted new designs", async () => {
    const pair = await paired(true);
    pair.send("create", "create_design", { sessionId: status.sessionId });
    await pair.browser.next("command");
    const created = { ...status, revision: 2, designId: "created-by-agent" };
    pair.browser.ws.send(
      JSON.stringify({
        t: "result",
        requestId: "create",
        result: { ok: true, value: created, status: created },
      }),
    );
    expect((await pair.agent.next("result", "create")).result.value.designId).toBe(
      created.designId,
    );
    pair.send("create", "create_design", { sessionId: status.sessionId });
    expect((await pair.agent.next("result", "create")).result.value.designId).toBe(
      created.designId,
    );
    pair.send("create", "create_design", { name: "different" });
    expect((await pair.agent.next("result", "create")).result.error.code).toBe("REQUEST_ID_REUSED");
    pair.send("read-created", "get_design", { designId: created.designId });
    expect((await pair.browser.next("command")).command.requestId).toBe("read-created");
  });

  it("reports unknown writes after disconnect, never replays them and revokes both peers", async () => {
    const pair = await paired();
    pair.send("edit", "apply_design_actions", { designId: status.designId });
    await pair.browser.next("command");
    pair.browser.ws.terminate();
    expect((await pair.agent.next("result", "edit")).result.error.code).toBe("OUTCOME_UNKNOWN");
    const browser = await socket(
      pair.origin,
      { role: "browser", pairingId: pair.created.pairingId, token: pair.approval.browserToken },
      pair.origin,
    );
    await browser.next("ready");
    pair.send("edit", "apply_design_actions", { designId: status.designId });
    expect((await pair.agent.next("result", "edit")).result.error.code).toBe("OUTCOME_UNKNOWN");
    expect(browser.messages.some((message) => message.t === "command")).toBe(false);
    const closed = once(pair.agent.ws, "close");
    expect(
      (
        await pair.post(
          "revoke",
          { pairingId: pair.created.pairingId },
          null,
          pair.approval.browserToken,
        )
      ).revoked,
    ).toBe(true);
    expect((await closed)[0]).toBe(4001);
  });

  it("expires codes and bounds room allocation", async () => {
    const { post } = await start({ maxRooms: 1, pairingTtlMs: 5 });
    const first = await post("pairings", { v: 1 });
    expect((await post("pairings", { v: 1 })).error.code).toBe("BUSY");
    const code = JSON.parse(
      Buffer.from(first.code.slice(RELAY_PAIRING_PREFIX.length), "base64url").toString(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (await post("approve", { pairingId: first.pairingId, userCode: code.userCode, status })).error
        .code,
    ).toBe("NOT_FOUND");
  });

  it("shares an outbound-only client with no listening port, reconnect replay or persisted credential", async () => {
    const host = await start();
    const client = new RelayConnection(host.origin);
    cleanup.push(() => client.close());
    const listen = vi.spyOn(Server.prototype, "listen");
    await client.start();
    const creating = client.beginPairing();
    await expect(client.beginPairing()).rejects.toMatchObject({ code: "BUSY" });
    const code = await creating;
    expect(listen).not.toHaveBeenCalled();
    const decoded = JSON.parse(
      Buffer.from(code.code.slice(RELAY_PAIRING_PREFIX.length), "base64url").toString(),
    );
    const approval = await host.post("approve", {
      ...decoded,
      v: undefined,
      origin: undefined,
      status,
    });
    const browser = await socket(
      host.origin,
      { role: "browser", pairingId: decoded.pairingId, token: approval.browserToken },
      host.origin,
    );
    await browser.next("ready");
    await vi.waitFor(() => expect(client.status().connected).toBe(true));
    const result = client.call("get_design", { designId: status.designId });
    const requestId = (await browser.next("command")).command.requestId;
    browser.ws.send(
      JSON.stringify({
        t: "result",
        requestId,
        result: { ok: true, value: { marker: "actual-browser" }, status },
      }),
    );
    expect(await result).toMatchObject({ ok: true, value: { marker: "actual-browser" } });
    const pending = client.call(
      "apply_design_actions",
      { requestId: "cancelled", designId: status.designId },
      AbortSignal.timeout(80),
    );
    await browser.next("command");
    await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await client.close();
    expect(client.status().connected).toBe(false);
    expect(client.status()).not.toHaveProperty("deviceToken");
  });
});
