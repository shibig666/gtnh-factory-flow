import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./[action]/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const send = (action: string, body = "{}", headers: Record<string, string> = {}) =>
  POST(
    new Request("https://planner.example/api/agent/" + action, { method: "POST", body, headers }),
    { params: Promise.resolve({ action }) },
  );

it("disables the relay unless explicitly configured and exposes only the three pairing routes", async () => {
  vi.stubEnv("AGENT_RELAY_INTERNAL_URL", "");
  expect((await send("pairings")).status).toBe(503);
  expect((await send("health")).status).toBe(404);
});
it("forwards origin and bearer but never cookies or caller-controlled proxy credentials", async () => {
  vi.stubEnv("AGENT_RELAY_INTERNAL_URL", "http://127.0.0.1:3002");
  vi.stubEnv("AGENT_RELAY_PROXY_TOKEN", "server-secret");
  const fetcher = vi.fn(async () => Response.json({ revoked: true }));
  vi.stubGlobal("fetch", fetcher);
  const response = await send("revoke", '{"pairingId":"123"}', {
    origin: "https://planner.example",
    authorization: "Bearer device",
    cookie: "private-session",
    "x-agent-proxy-token": "forged",
  });
  expect(response.status).toBe(200);
  const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.href).toBe("http://127.0.0.1:3002/api/agent/revoke");
  const headers = new Headers(init.headers);
  expect(headers.get("origin")).toBe("https://planner.example");
  expect(headers.get("authorization")).toBe("Bearer device");
  expect(headers.get("cookie")).toBeNull();
  expect(headers.get("x-agent-proxy-token")).toBe("server-secret");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("bounds request size and reports unavailable service without leaking internal addresses", async () => {
  vi.stubEnv("AGENT_RELAY_INTERNAL_URL", "http://127.0.0.1:3002");
  const fetcher = vi.fn(async () => {
    throw new Error("private address");
  });
  vi.stubGlobal("fetch", fetcher);
  expect((await send("pairings", "x".repeat(16385))).status).toBe(413);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await send("pairings");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private address");
});
