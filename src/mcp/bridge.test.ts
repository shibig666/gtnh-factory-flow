import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserBridge } from "./bridge";

const bridges: BrowserBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});
async function setup() {
  const bridge = new BrowserBridge("http://localhost:3000");
  bridges.push(bridge);
  await bridge.start();
  const code = bridge.beginPairing().code;
  return { bridge, config: JSON.parse(Buffer.from(code.split(".")[1], "base64url").toString()) };
}
async function pair(config: { url: string; token: string; apiBaseUrl: string; v: number }) {
  const ws = new WebSocket(config.url, { origin: config.apiBaseUrl });
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          t: "hello",
          token: config.token,
          apiBaseUrl: config.apiBaseUrl,
          browserId: "test-browser",
          v: config.v,
          status: { sessionId: "test-browser", revision: 2 },
        }),
      ),
    );
    ws.once("message", (raw) =>
      JSON.parse(raw.toString()).t === "ready" ? resolve() : reject(new Error("Not ready")),
    );
  });
  return ws;
}

describe("local agent bridge", () => {
  it("refuses a command cancelled before dispatch", async () => {
    const { bridge } = await setup();
    const controller = new AbortController();
    controller.abort();
    expect(() => bridge.call("list_designs", {}, controller.signal)).toThrow(/abort/i);
  });
  it("reports an interrupted command as unknown and ignores its late acknowledgement", async () => {
    const { bridge, config } = await setup();
    const ws = await pair(config);
    const received = new Promise<{ command: { requestId: string } }>((resolve) =>
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
    );
    const controller = new AbortController();
    const outcome = bridge
      .call("list_designs", {}, controller.signal)
      .catch((error: unknown) => error);
    const frame = await received;
    controller.abort();
    expect(await outcome).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    ws.send(
      JSON.stringify({
        t: "result",
        requestId: frame.command.requestId,
        result: { ok: true, value: "late" },
      }),
    );
    ws.once("message", (raw) => {
      const next = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          t: "result",
          requestId: next.command.requestId,
          result: { ok: true, value: "fresh" },
        }),
      );
    });
    expect(await bridge.call("list_designs", {})).toEqual({ ok: true, value: "fresh" });
  });
  it("authenticates an exact origin and routes a correlated browser command", async () => {
    const { bridge, config } = await setup();
    const ws = await pair(config);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          t: "result",
          requestId: frame.command.requestId,
          result: { ok: true, value: "answer" },
        }),
      );
    });
    expect(await bridge.call("list_designs", {})).toEqual({ ok: true, value: "answer" });
    expect(bridge.status().connected).toBe(true);
    expect(JSON.stringify(bridge.status())).not.toContain(config.token);
  });
  it("refuses unpaired calls and a webpage from another origin", async () => {
    const { bridge, config } = await setup();
    expect(() => bridge.call("list_designs", {})).toThrow(/begin_pairing/);
    const ws = new WebSocket(config.url, { origin: "http://untrusted.example" });
    await new Promise<void>((resolve) => ws.once("error", () => resolve()));
    expect(bridge.status().connected).toBe(false);
  });
  it("refuses wrong credentials even from the correct origin", async () => {
    const { bridge, config } = await setup();
    const ws = new WebSocket(config.url, { origin: config.apiBaseUrl });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          t: "hello",
          token: "wrong",
          browserId: "x",
          apiBaseUrl: config.apiBaseUrl,
          v: 1,
        }),
      ),
    );
    await new Promise<void>((resolve) =>
      ws.once("close", (code) => {
        expect(code).toBe(1008);
        resolve();
      }),
    );
    expect(bridge.status().connected).toBe(false);
  });
  it("reports uncertain write outcome on disconnect instead of replaying", async () => {
    const { bridge, config } = await setup();
    const ws = await pair(config);
    ws.on("message", () => ws.close());
    await expect(bridge.call("undo_design", { requestId: "write-1" })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
  });
  it("allows a remote data origin for queries but refuses canvas pairing", async () => {
    const bridge = new BrowserBridge("https://example.com");
    bridges.push(bridge);
    await bridge.start();
    expect(() => bridge.beginPairing()).toThrow(/local planner instance/);
  });
});
