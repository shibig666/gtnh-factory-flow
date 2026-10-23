import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDshClient } from "./test-runtime.mjs";

const version = {
  id: "dsh-fixture-2.9",
  gtnhVersion: "2.9",
  channel: "stable",
  publishedAt: "2026-01-01T00:00:00Z",
  checksumSha256: "dsh-fixture-fingerprint",
  manifestPath: "/datasets/gtnh/dsh-fixture-2.9/manifest.json",
  recipeDatasetPath: "/datasets/gtnh/dsh-fixture-2.9/recipes.json.gz",
  sourceInfo: {
    sourceId: "gtnh-oracle",
    generatedAt: "2026-01-01T00:00:00Z",
    notes: "DSH fixture",
  },
};
let requestReceived;
const api = createServer((_req, res) => {
  if (requestReceived) {
    const resolve = requestReceived;
    requestReceived = undefined;
    resolve();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({ schemaVersion: 1, latestStableVersion: version.id, versions: [version] }),
  );
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;
let client;
const report = { fixture: true };
try {
  client = await createDshClient(origin);
  report.runtime = client.runtimeVersion;
  report.package = client.installation.metadata.name;
  report.toolCount = (await client.listTools()).tools.length;
  assert.equal(report.toolCount, 19);
  for (const name of [
    "get_status",
    "list_datasets",
    "apply_design_actions",
    "evaluate_design",
    "undo_design",
    "redo_design",
    "export_design_image",
  ]) {
    assert.ok(client.ctx.tools.get(`gtnh_${name}`));
  }
  const status = (await client.callTool({ name: "get_status" })).structuredContent;
  assert.equal(status.plannerUrl, origin);
  assert.equal(status.connected, false);
  const datasetResponse = await client.callTool({ name: "list_datasets" });
  assert.ok(!datasetResponse.isError, JSON.stringify(datasetResponse));
  const datasets = datasetResponse.structuredContent;
  assert.equal(datasets.versions[0].id, version.id);
  assert.equal(client.ctx.skills, undefined);
  assert.deepEqual((await readdir(path.join(client.installation.packageRoot, "lib"))).sort(), [
    "client.js",
    "index.mjs",
  ]);
  assert.ok(
    !Object.keys(client.installation.metadata.peerDependencies).some((name) =>
      /mcp|skill/.test(name),
    ),
  );
  const instructions = await readFile("plugins/dsh-gtnh-planner/instructions.md", "utf8");
  assert.ok(client.guidance.text.endsWith(instructions));
  assert.ok(client.guidance.text.includes("grant.allowCreate"));
  assert.ok(client.guidance.text.includes("no client listening port"));
  report.nativeSdk = true;
  const code = (await client.callTool({ name: "begin_pairing" })).structuredContent;
  assert.equal(typeof code.code, "string");
  report.pairing = true;
  const before = await client.callTool({ name: "get_design" });
  assert.equal(before.isError, true);
  assert.ok(before.content[0].text.length);
  report.errorsVisible = true;
  const deny = client.ctx.tools.guard((exec) =>
    exec.name === "gtnh_begin_pairing" ? "fixture permission denied" : undefined,
  );
  const refused = await client.callTool({ name: "begin_pairing" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /fixture permission denied/);
  deny();
  report.permissionGuard = true;
  const controller = new AbortController();
  const received = new Promise((resolve) => {
    requestReceived = resolve;
  });
  const pending = client.ctx.tools.execute({
    callId: randomUUID(),
    name: "gtnh_list_datasets",
    arguments: {},
    signal: controller.signal,
  });
  await received;
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.match(JSON.stringify(cancelled.error), /ABORTED|abort/i);
  report.cancellation = true;
  await client.fiber.dispose();
  assert.equal(client.ctx.tools.get("gtnh_get_status"), undefined);
  assert.ok(
    !(await client.ctx.systemPrompt.assemble()).sections.some(
      (section) => section.name === "gtnh-planner",
    ),
  );
  report.unload = true;
  const reenabled = client.ctx.plugin(client.plugin, { plannerUrl: origin });
  await reenabled;
  assert.equal((await client.callTool({ name: "get_status" })).structuredContent.connected, false);
  await reenabled.dispose();
  report.reenable = true;
  report.pass = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile("scratch/dsh-tests/report.json", JSON.stringify(report, null, 2));
  await client?.close();
  await new Promise((resolve) => api.close(resolve));
}
