import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { PlannerTransport } from "./planner-transport";
import { PlannerApi } from "./data-client";
import { RelayConnection } from "./relay-connection";
import { createPlannerTools } from "./tools";

// Public, test-only key material serves no production endpoint or identity.
const key = readFileSync(new URL("./__fixtures__/tls-key.pem", import.meta.url));
const cert = readFileSync(new URL("./__fixtures__/tls-cert.pem", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  let origin = "";
  let onHang = () => {};
  const writes: string[] = [];
  let helloCount = 0;
  let manifestCalls = 0;
  const server = createServer({ key, cert }, (req, res) => {
    if (req.url === "/hang") {
      onHang();
      return;
    }
    if (req.url?.includes("manifest")) {
      manifestCalls++;
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(JSON.stringify({ schemaVersion: 1, versions: [] })));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      writes.push(req.url!);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/agent/pairings")
        res.end(
          JSON.stringify({
            plannerUrl: origin,
            pairingId: "test-pairing",
            deviceToken: "t".repeat(40),
            code: "test-code",
            expiresAt: Date.now() + 60000,
          }),
        );
      else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://other.invalid/" }).end();
      } else {
        res.statusCode = 503;
        res.end(JSON.stringify({ body }));
      }
    });
  });
  const sockets = new WebSocketServer({ server, path: "/agent/ws" });
  sockets.on("connection", (ws) =>
    ws.on("message", () => {
      helloCount++;
      ws.send(JSON.stringify({ t: "ready" }));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    sockets.clients.forEach((ws) => ws.terminate());
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin,
    writes,
    count: () => ({ helloCount, manifestCalls }),
    hang: () =>
      new Promise<void>((resolve) => {
        onHang = resolve;
      }),
  };
}

describe("origin-scoped planner compatibility", () => {
  it("reads self-signed HTTPS recipes with warnings and keeps global TLS validation intact", async () => {
    const { origin, count } = await fixture();
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await expect(fetch(origin)).rejects.toThrow();
    const notices: string[] = [];
    const transport = new PlannerTransport(origin, (warning) => notices.push(warning.code));
    const api = new PlannerApi(origin, transport.request, () => transport.warnings());
    const tools = createPlannerTools(api, {
      status: () => ({}),
      beginPairing: () => ({}),
      call: async () => ({}),
    });
    const result = await tools.find((tool) => tool.name === "list_datasets")!.run({});
    expect(result).toMatchObject({
      schemaVersion: 1,
      securityWarnings: [{ code: "TLS_UNTRUSTED" }],
    });
    expect(count().manifestCalls).toBe(1);
    await api.manifest();
    const parallel = new PlannerTransport(origin);
    await Promise.all([
      parallel.request(`${origin}/manifest`),
      parallel.request(`${origin}/manifest`),
    ]);
    expect(parallel.warnings()).toHaveLength(1);
    expect(notices).toEqual(["TLS_UNTRUSTED"]);
    await expect(fetch(origin)).rejects.toThrow();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(previousTls);
    await expect(transport.request("https://another.invalid/")).rejects.toThrow(
      "configured origin",
    );
  });

  it("pairs over self-signed HTTPS and WSS and never retries delivered writes or follows redirects", async () => {
    const { origin, writes, count } = await fixture();
    const transport = new PlannerTransport(origin);
    const connection = new RelayConnection(origin, transport);
    cleanups.push(() => connection.close());
    const pairing = await connection.beginPairing();
    expect(pairing).toMatchObject({
      transport: "relay",
      securityWarnings: [{ code: "TLS_UNTRUSTED" }],
    });
    expect(count().helloCount).toBe(1);
    expect(writes.filter((path) => path === "/api/agent/pairings")).toHaveLength(1);
    const failure = await transport.request(`${origin}/edit`, {
      method: "POST",
      body: "test-edit",
    });
    expect(failure.status).toBe(503);
    expect(writes.filter((path) => path === "/edit")).toHaveLength(1);
    const redirect = await transport.request(`${origin}/redirect`, { method: "POST" });
    expect(redirect.status).toBe(302);
    expect(writes.filter((path) => path === "/redirect")).toHaveLength(1);
  });

  it("still cancels HTTPS requests after certificate fallback", async () => {
    const fixtureServer = await fixture();
    const transport = new PlannerTransport(fixtureServer.origin);
    await (
      await transport.request(`${fixtureServer.origin}/datasets/gtnh/datasets.manifest.json`)
    ).json();
    const received = fixtureServer.hang();
    const controller = new AbortController();
    const request = transport.request(`${fixtureServer.origin}/hang`, {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toThrow(/abort/i);
    await received;
    controller.abort();
    await rejected;
  });
});
