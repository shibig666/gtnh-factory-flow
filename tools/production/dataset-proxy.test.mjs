import { afterEach, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { EnvHttpProxyAgent } from "undici";
import { DatasetProxy, proxyDescription } from "./dataset-proxy.mjs";

const key = readFileSync("src/lib/agent/__fixtures__/tls-key.pem");
const cert = readFileSync("src/lib/agent/__fixtures__/tls-cert.pem");
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function fixture() {
  const received = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body, headers: req.headers });
      const payload = gzipSync(JSON.stringify({ ok: true, query: req.url }));
      res.writeHead(req.url.includes("unavailable") ? 503 : 200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": payload.length,
        "Cache-Control": "public, max-age=90",
        ETag: '"fixture"',
      });
      res.end(req.method === "HEAD" ? undefined : payload);
    });
  };
  const plainPort = await listen(createServer(handler));
  const tlsPort = await listen(createHttpsServer({ key, cert }, handler));
  const tunnels = [];
  const proxy = createServer((req, res) => res.writeHead(500).end());
  proxy.on("connect", (req, socket, head) => {
    tunnels.push(req.url);
    const remote = connect(req.url.endsWith(":443") ? tlsPort : plainPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) remote.write(head);
      remote.pipe(socket).pipe(remote);
    });
    socket.on("error", () => remote.destroy());
    remote.on("error", () => socket.destroy());
    socket.once("close", () => remote.destroy());
  });
  const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  return { received, tunnels, proxyUrl, plainPort };
}

async function frontend(forwarder) {
  const port = await listen(
    createServer((req, res) => {
      if (forwarder.handles(req.url)) void forwarder.forward(req, res);
      else res.writeHead(404).end();
    }),
  );
  cleanups.push(() => forwarder.close());
  return `http://127.0.0.1:${port}`;
}

function raw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

it("reads HTTPS data through CONNECT and preserves POST queries, gzip and cache headers", async () => {
  const f = await fixture();
  const forwarder = new DatasetProxy("https://recipes.invalid/base", {
    dispatcher: new EnvHttpProxyAgent({
      httpProxy: f.proxyUrl,
      httpsProxy: f.proxyUrl,
      noProxy: "",
      requestTls: { ca: cert, servername: "localhost" },
    }),
  });
  const origin = await frontend(forwarder);
  const result = await raw(`${origin}/api/datasets/test/resolve-recipes?limit=104&query=a%2Bb`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"recipes":[]}',
  });
  expect(result.status).toBe(200);
  expect(result.headers).toMatchObject({
    "content-encoding": "gzip",
    "cache-control": "public, max-age=90",
    etag: '"fixture"',
  });
  expect(Number(result.headers["content-length"])).toBe(result.bytes.length);
  expect(JSON.parse(gunzipSync(result.bytes).toString())).toMatchObject({ ok: true });
  expect(f.tunnels).toEqual(["recipes.invalid:443"]);
  expect(f.received[0]).toMatchObject({
    method: "POST",
    url: "/base/api/datasets/test/resolve-recipes?limit=104&query=a%2Bb",
    body: '{"recipes":[]}',
  });
  const unavailable = await raw(`${origin}/api/datasets/unavailable`);
  expect(unavailable.status).toBe(503);
  expect(f.received.filter((entry) => entry.url.includes("unavailable"))).toHaveLength(1);
  const head = await raw(`${origin}/datasets/gtnh/test/icon.png`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.bytes.length).toBe(0);
  expect(forwarder.handles("/api/agent/pairings")).toBe(false);
  expect(forwarder.handles("/api/datasets-other/test")).toBe(false);
});

it("honors lowercase proxy variables and NO_PROXY while leaving global requests untouched", async () => {
  const f = await fixture();
  vi.stubEnv("HTTP_PROXY", "http://invalid-proxy.invalid:1");
  vi.stubEnv("http_proxy", f.proxyUrl);
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("no_proxy", "localhost,127.0.0.1");
  const remote = await frontend(new DatasetProxy("http://recipes.invalid"));
  expect((await raw(`${remote}/datasets/gtnh/test/icon.png`)).status).toBe(200);
  expect(f.tunnels).toEqual(["recipes.invalid:80"]);
  const local = await frontend(new DatasetProxy(`http://127.0.0.1:${f.plainPort}`));
  expect((await raw(`${local}/api/datasets/test/resources`)).status).toBe(200);
  expect((await raw(`http://127.0.0.1:${f.plainPort}/direct`)).status).toBe(200);
  expect(f.tunnels).toHaveLength(1);
  expect(proxyDescription({ https_proxy: "http://user:secret@proxy.test:7890" })).not.toContain(
    "secret",
  );
});

it("returns an actionable 502 when the proxy cannot connect without leaking credentials", async () => {
  vi.stubEnv("http_proxy", "http://user:private-password@127.0.0.1:1");
  vi.stubEnv("no_proxy", "");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const origin = await frontend(new DatasetProxy("http://recipes.invalid"));
  const result = await raw(`${origin}/api/datasets/test/resources`);
  expect(result.status).toBe(502);
  expect(JSON.parse(result.bytes)).toMatchObject({
    error: { code: "DATASET_BACKEND_UNAVAILABLE" },
  });
  expect(JSON.stringify(errors.mock.calls)).not.toContain("private-password");
});

it("uses the explicit proxy and ignores inherited proxy settings when disabled", async () => {
  const f = await fixture();
  vi.stubEnv("http_proxy", "http://127.0.0.1:1");
  vi.stubEnv("no_proxy", "");
  const explicit = await frontend(
    new DatasetProxy("http://recipes.invalid", {
      proxy: { mode: "explicit", url: f.proxyUrl },
    }),
  );
  expect((await raw(`${explicit}/api/datasets/test/resources`)).status).toBe(200);
  expect(f.tunnels).toEqual(["recipes.invalid:80"]);
  const direct = await frontend(
    new DatasetProxy(`http://127.0.0.1:${f.plainPort}`, { proxy: { mode: "direct" } }),
  );
  expect((await raw(`${direct}/datasets/gtnh/test/icon.png`)).status).toBe(200);
  expect(f.tunnels).toHaveLength(1);
  expect(proxyDescription(process.env, { mode: "direct" })).toContain("已关闭");
});
