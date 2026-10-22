import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const moduleRoot =
  process.env.GTNH_DSH_MODULE_ROOT ?? path.join(homedir(), ".dsh/profiles/node_modules");
const host = createRequire(path.join(moduleRoot, "gtnh-install-test.cjs"));
const cli = path.join(path.dirname(host.resolve("@deepseek-ai/dsh/package.json")), "lib/bin.js");
await mkdir("scratch/dsh-installs", { recursive: true });
const home = await mkdtemp(path.resolve("scratch/dsh-installs/home-"));
const metadata = JSON.parse(await readFile("plugins/dsh-gtnh-planner/package.json", "utf8"));
const archive = path.resolve(`dist-dsh/${metadata.name}-${metadata.version}.tgz`);
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: "1",
  npm_config_store_dir: path.resolve("scratch/dsh-installs/pnpm-store"),
};
const child = spawn(
  process.execPath,
  [cli, "plugin", "--profile", "web", "add", archive, "--ignore-scripts"],
  {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let log = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    log += chunk;
  });
const exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", resolve);
});
await writeFile(path.join(home, "install.log"), log);
assert.equal(exitCode, 0, log);
const manifest = JSON.parse(await readFile(path.join(home, "profiles/web/package.json"), "utf8"));
assert.ok(manifest.dsh.profile.bundles.includes(metadata.name));
// Probe only this bundle's schema; stock profile preset schemas are outside this package's contract.
await writeFile(
  path.join(home, "profiles/web/package.json"),
  JSON.stringify(
    {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [metadata.name] } },
    },
    null,
    2,
  ),
);
let schema;
try {
  schema = execFileSync(process.execPath, [cli, "--profile", "web", "--dump-config-schema"], {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  throw new Error(error.stderr?.toString() || error.message);
} finally {
  await writeFile(path.join(home, "profiles/web/package.json"), JSON.stringify(manifest, null, 2));
}
assert.match(schema, /gtnh-planner/);
assert.match(schema, /plannerUrl/);
const report = { pass: true, installed: metadata.name, profile: home, schemaLoaded: true };
await writeFile("scratch/dsh-installs/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
