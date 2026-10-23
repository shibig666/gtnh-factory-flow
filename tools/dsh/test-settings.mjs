import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import path from "node:path";
import { installTestPackage } from "./test-runtime.mjs";

const host = createRequire(
  path.resolve(
    process.env.GTNH_DSH_MODULE_ROOT ?? path.join(homedir(), ".dsh/profiles/node_modules"),
    "gtnh-settings-test.cjs",
  ),
);
const load = async (name) => import(pathToFileURL(host.resolve(name)).href);
const installation = await installTestPackage();
await mkdir("scratch/dsh-settings", { recursive: true });
const home = await mkdtemp(path.resolve("scratch/dsh-settings/home-"));
const dir = path.join(home, "profile");
await mkdir(dir);
await writeFile(
  path.join(dir, "package.json"),
  JSON.stringify({ dsh: { profile: { bundles: [] } } }),
);
const configPath = path.join(dir, "cordis.yml");
const patchPath = path.join(dir, "cordis.patch.yml");
await writeFile(configPath, "[]\n");
let calls = [0, 0];
let requestReceived;
const servers = calls.map((_, index) =>
  createServer((_req, res) => {
    calls[index]++;
    if (index === 0 && requestReceived) {
      const resolve = requestReceived;
      requestReceived = undefined;
      resolve();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ schemaVersion: 1, versions: [], latestStableVersion: `site-${index}` }),
    );
  }),
);
await Promise.all(
  servers.map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))),
);
const origins = servers.map((server) => `http://127.0.0.1:${server.address().port}`);
const pluginPath = pathToFileURL(path.join(installation.packageRoot, "lib/index.mjs")).href;
const patches = [
  {
    insert: [
      {
        id: "gtnh-planner",
        name: pluginPath,
        config: { plannerUrl: origins[0], connectionMode: "auto" },
      },
    ],
  },
];
await writeFile(patchPath, JSON.stringify(patches));
let ctx;
const report = { package: installation.metadata.version };
try {
  const [boot, prompt, tools, attachments, editor, settings] = await Promise.all([
    load("@deepseek-ai/dsh-app-boot"),
    load("@deepseek-ai/dsh-system-prompt"),
    load("@deepseek-ai/dsh-tools"),
    load("@deepseek-ai/dsh-attachment-local"),
    load("@deepseek-ai/dsh-config-editor"),
    load("@deepseek-ai/dsh-settings"),
  ]);
  ctx = await boot.boot("gtnh-settings-test", configPath, patches, async (root) => {
    root.provide("profileContext", {
      name: "gtnh-test",
      dir,
      home,
      patchPath,
      installAnchor: host.resolve("@deepseek-ai/dsh/package.json"),
      cwd: dir,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: "1",
    });
    root.plugin(attachments.default, { dshHome: home });
    root.plugin(prompt.default, {});
    root.plugin(tools.default, { mode: "native" });
    root.plugin(editor.default);
    root.plugin(settings.default);
  });
  const descriptor = () => ctx.settings.describe().find((entry) => entry.ns === "gtnh-planner");
  assert.equal(descriptor().value.plannerUrl, origins[0]);
  assert.equal(descriptor().applies, "live");
  const entry = [...ctx.loader.entries()].find((entry) => entry.options.id === "gtnh-planner");
  const fiber = entry.fiber;
  const invoke = (name) =>
    ctx.tools.execute({
      callId: crypto.randomUUID(),
      name: `gtnh_${name}`,
      arguments: {},
      signal: AbortSignal.timeout(10000),
    });
  assert.equal((await invoke("list_datasets")).isError, false);
  const oldPairing = (await invoke("begin_pairing")).value;
  const received = new Promise((resolve) => {
    requestReceived = resolve;
  });
  const pending = invoke("list_datasets");
  await received;
  const before = descriptor().revision;
  await ctx.settings.mutate(
    "gtnh-planner",
    [
      { op: "set", path: ["plannerUrl"], value: origins[1] },
      { op: "set", path: ["connectionMode"], value: "relay" },
    ],
    before,
  );
  assert.equal(entry.fiber, fiber, "Live config must not unload registered tools");
  assert.equal(descriptor().value.plannerUrl, origins[1]);
  assert.equal(
    (await pending).isError,
    true,
    "Settings changes must cancel requests to the old site",
  );
  const oldBridge = JSON.parse(Buffer.from(oldPairing.code.split(".")[1], "base64url")).url;
  await assert.rejects(fetch(oldBridge.replace("ws:", "http:")), /fetch failed/);
  const status = (await invoke("get_status")).value;
  assert.equal(status.plannerUrl, origins[1]);
  assert.equal(status.transport, "relay");
  assert.equal(status.connected, false);
  assert.equal((await invoke("list_datasets")).isError, false);
  assert.deepEqual(calls, [2, 1], "New recipe requests must reach only the new planner");
  const persisted = await readFile(patchPath, "utf8");
  assert.ok(persisted.includes(origins[1]));
  assert.ok(persisted.includes("relay"));
  await assert.rejects(
    ctx.settings.update("gtnh-planner", { plannerUrl: origins[0] }, before),
    (error) => error.code === "SETTINGS_CONFLICT",
  );
  const accepted = await readFile(patchPath, "utf8");
  for (const config of [
    { plannerUrl: "https://example.com/path" },
    { plannerUrl: "http://example.com" },
    { plannerUrl: "https://user:secret@example.com" },
    { plannerUrl: "https://example.com", connectionMode: "local" },
  ]) {
    await assert.rejects(ctx.settings.update("gtnh-planner", config, descriptor().revision));
    assert.equal(
      await readFile(patchPath, "utf8"),
      accepted,
      "Rejected settings must not reach disk",
    );
    assert.equal((await invoke("get_status")).value.plannerUrl, origins[1]);
  }
  Object.assign(report, {
    pass: true,
    liveSettings: true,
    persistentProfile: true,
    newRecipeOrigin: true,
    oldBridgeClosed: true,
    interruptedCallCancelled: true,
    staleWriteRefused: true,
    invalidWriteRefused: true,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await ctx?.fiber.dispose();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  installation.release();
  await writeFile("scratch/dsh-settings/report.json", JSON.stringify(report, null, 2));
}
