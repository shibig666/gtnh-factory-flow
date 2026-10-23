import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCertificate } from "./certificate.mjs";

const output = path.resolve("scratch/production-proxy");
await mkdir(output, { recursive: true });
const routes = JSON.parse(await readFile(".next/routes-manifest.json", "utf8"));
const rewrites = Array.isArray(routes.rewrites) ? routes.rewrites : routes.rewrites.beforeFiles;
const destination = rewrites.find((rule) => rule.source === "/api/datasets/:path*")?.destination;
assert.ok(destination, "Build with GTNH_DATASET_BACKEND_URL before proxy acceptance");
const backend = new URL(destination.slice(0, -"/api/datasets/:path*".length));
const certificate = await loadCertificate(path.join(output, "tls"), backend.hostname);
const sockets = new Set();
const listen = async (server) => {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const received = [];
const handler = (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({
      method: req.method,
      path: req.url,
      body,
      proxyAuth: req.headers["proxy-authorization"],
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=60" });
    res.end(JSON.stringify({ marker: "proxy-fixture", method: req.method, path: req.url }));
  });
};
const upstream =
  backend.protocol === "https:" ? createHttpsServer(certificate, handler) : createServer(handler);
const upstreamPort = await listen(upstream);
const tunnels = [];
const proxy = createServer((req, res) => res.writeHead(500).end());
proxy.on("connect", (req, socket, head) => {
  tunnels.push(req.url);
  const remote = connect(upstreamPort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
  });
  socket.once("close", () => remote.destroy());
  socket.on("error", () => remote.destroy());
  remote.on("error", () => socket.destroy());
});
const proxyPort = await listen(proxy);
const finder = createServer();
const port = await listen(finder);
await new Promise((resolve) => finder.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const proxyUrl = `http://fixture-user:fixture-secret@127.0.0.1:${proxyPort}`;
const child = spawn(
  process.execPath,
  [
    "dist-server/server.mjs",
    "--host",
    "127.0.0.1",
    "--protocol",
    "http",
    "--port",
    String(port),
    "--proxy",
    proxyUrl,
  ],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GTNH_PREWARM_ON_STARTUP: "0",
      GTNH_DATASET_BACKEND_URL: backend.href.replace(/\/$/, ""),
      NODE_EXTRA_CA_CERTS: certificate.certPath,
      NODE_USE_ENV_PROXY: "0",
      no_proxy: "",
      NO_PROXY: "",
    },
  },
);
let log = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (log += chunk));
try {
  const until = Date.now() + 45000;
  let ready = false;
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, log);
    try {
      ready = (await fetch(`${origin}/_server/health`)).ok;
    } catch {
      /* Starting. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, "Production server did not start");
  for (const [method, resource] of [
    ["GET", "/api/datasets/test/resources?offset=120&limit=104"],
    ["POST", "/api/datasets/test/resolve-recipes"],
    ["GET", "/datasets/gtnh/test/icon.png"],
  ]) {
    const response = await fetch(origin + resource, {
      method,
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json" }, body: '{"recipes":[]}' }
        : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).marker, "proxy-fixture");
  }
  const pairing = await fetch(`${origin}/api/agent/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"v":1}',
  });
  assert.equal(pairing.status, 201, "Pairing endpoint refused the internal request");
  assert.ok((await pairing.json()).code);
  assert.equal(received.length, 3);
  assert.ok(received.every((request) => request.proxyAuth === undefined));
  assert.ok(tunnels.length > 0);
  assert.ok(
    tunnels.every(
      (authority) =>
        authority ===
        `${backend.hostname}:${backend.port || (backend.protocol === "https:" ? 443 : 80)}`,
    ),
  );
  assert.ok(log.includes("配方代理设置"));
  assert.ok(!log.includes("fixture-secret"));
  const report = {
    pass: true,
    configuredProxy: true,
    recipes: true,
    post: true,
    images: true,
    relayDirect: true,
    credentialsRedacted: true,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
  await writeFile(path.join(output, "server.log"), log);
}
