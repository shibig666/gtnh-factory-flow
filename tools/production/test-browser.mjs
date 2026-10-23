import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { PlannerTransport } from "../../src/lib/agent/planner-transport.ts";
import { RelayConnection } from "../../src/lib/agent/relay-connection.ts";

// Exercise the shipped listener and real Next pairing routes, not a test reverse proxy.
const root = process.cwd();
const output = path.resolve("scratch/production-browser");
await mkdir(output, { recursive: true });
const publicHost =
  process.env.GTNH_TEST_PUBLIC_HOST ??
  Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
assert.ok(publicHost, "A LAN IPv4 address is required");
const report = [];
const version = {
  id: "fixture-2.9",
  gtnhVersion: "2.9",
  channel: "stable",
  publishedAt: "2026-01-01T00:00:00Z",
  manifestPath: "/fixture/manifest.json",
  recipeDatasetPath: "/fixture/recipes.json.gz",
  checksumSha256: "fixture",
  sourceInfo: { sourceId: "fixture", generatedAt: "2026-01-01T00:00:00Z" },
};

async function waitFor(predicate, message, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}

for (const protocol of ["http", "https"]) {
  const finder = createServer();
  await new Promise((resolve) => finder.listen(0, "127.0.0.1", resolve));
  const port = finder.address().port;
  await new Promise((resolve) => finder.close(resolve));
  const origin = `${protocol}://${publicHost}:${port}`;
  const args = [
    "--host",
    "0.0.0.0",
    "--protocol",
    protocol,
    "--port",
    String(port),
    "--public-host",
    publicHost,
    "--state-dir",
    path.join(output, "tls"),
  ];
  const windowsWrapper = process.env.GTNH_TEST_WINDOWS_WRAPPER === "1";
  const child = spawn(
    windowsWrapper ? "powershell.exe" : process.execPath,
    windowsWrapper
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/production/start.ps1", ...args]
      : ["dist-server/server.mjs", ...args],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Browser fixtures supply recipes; ignore an unbuilt backend from the developer's env file.
      env: { ...process.env, GTNH_PREWARM_ON_STARTUP: "0", GTNH_DATASET_BACKEND_URL: "" },
    },
  );
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (log += chunk));
  const transport = new PlannerTransport(origin);
  const relay = new RelayConnection(origin, transport);
  let browser;
  try {
    await waitFor(async () => {
      assert.equal(child.exitCode, null, log);
      try {
        return (await transport.request(`${origin}/_server/health`)).ok;
      } catch {
        return false;
      }
    }, "Production server did not start");
    const health = await (await transport.request(`${origin}/_server/health`)).json();
    assert.equal(health.origin, origin);
    assert.equal(health.relay, true);
    const pairing = await relay.beginPairing();
    browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: protocol === "https" });
    // Recipe fixtures are browser-only; pairing and WebSocket traffic reach the production server.
    await context.route("**/datasets/gtnh/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#b87533"/></svg>',
      }),
    );
    await context.route("**/datasets/gtnh/datasets.manifest.json", (route) =>
      route.fulfill({
        json: { schemaVersion: 1, latestStableVersion: version.id, versions: [version] },
      }),
    );
    await context.route("**/api/datasets/**", (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          datasetVersionId: version.id,
          gtnhVersion: "2.9",
          sourceInfo: version.sourceInfo,
          resources: [],
          resourceIndex: [],
          recipes: [],
          recipeCount: 0,
          oreDictionary: {},
          recipeMaps: [],
          generatedAt: version.publishedAt,
        },
      }),
    );
    await context.addInitScript(() =>
      localStorage.setItem("gtnh-factory-flow.mod-announcement-dismissed.v1", "1"),
    );
    const page = await context.newPage();
    const errors = [];
    const loading = new Set();
    page.on("request", (request) => loading.add(request.url()));
    page.on("requestfinished", (request) => loading.delete(request.url()));
    page.on("requestfailed", (request) => loading.delete(request.url()));
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "load" });
    } catch (error) {
      await writeFile(
        path.join(output, `${protocol}-pending.json`),
        JSON.stringify([...loading], null, 2),
      );
      throw error;
    }
    if (protocol === "http") {
      assert.deepEqual(
        await page.evaluate(() => [
          window.isSecureContext,
          typeof crypto.randomUUID,
          typeof crypto.subtle,
        ]),
        [false, "undefined", "undefined"],
      );
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByLabel("Agent pairing code").fill(pairing.code);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await waitFor(
      () => relay.status().connected,
      "Browser did not connect through production relay",
    );
    if (protocol === "https") {
      // HTTP handshake timeouts must not become idle timeouts on upgraded WSS sockets.
      await new Promise((resolve) => setTimeout(resolve, 11000));
      assert.equal(relay.status().connected, true);
    }
    await page.reload({ waitUntil: "load" });
    // Refresh intentionally drops the browser's in-memory grant; the UI must still load cleanly.
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.ok(
      transport
        .warnings()
        .some(
          (warning) =>
            warning.code === (protocol === "http" ? "HTTP_UNENCRYPTED" : "TLS_UNTRUSTED"),
        ),
    );
    report.push({
      protocol,
      origin,
      buildId: health.buildId,
      paired: true,
      reloaded: true,
      pageErrors: errors,
    });
  } finally {
    await relay.close();
    await browser?.close();
    if (child.exitCode === null) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    }
    await writeFile(path.join(output, `${protocol}.log`), log);
  }
}
// A failed startup must release its internal relay and exit, rather than hanging invisibly.
const occupied = createServer();
await new Promise((resolve) => occupied.listen(0, "0.0.0.0", resolve));
try {
  const failed = spawn(
    process.execPath,
    [
      "dist-server/server.mjs",
      "--host",
      "0.0.0.0",
      "--protocol",
      "http",
      "--port",
      String(occupied.address().port),
      "--public-host",
      publicHost,
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GTNH_PREWARM_ON_STARTUP: "0", GTNH_DATASET_BACKEND_URL: "" },
    },
  );
  let failureLog = "";
  for (const stream of [failed.stdout, failed.stderr])
    stream.on("data", (chunk) => (failureLog += chunk));
  try {
    await waitFor(() => failed.exitCode !== null, "Failed startup left a process running", 20000);
    assert.equal(failed.exitCode, 1, failureLog);
    assert.ok(failureLog.includes("端口已被占用"), failureLog);
  } finally {
    if (failed.exitCode === null) failed.kill();
  }
} finally {
  await new Promise((resolve) => occupied.close(resolve));
}
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify({ pass: true, startupFailureHandled: true, cases: report }, null, 2),
);
console.log(JSON.stringify({ pass: true, startupFailureHandled: true, cases: report }, null, 2));
