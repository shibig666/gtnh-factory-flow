import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

// Run test:dsh:install first: reuse only its isolated installation, never a user profile.
const installed = JSON.parse(await readFile("scratch/dsh-installs/report.json", "utf8"));
const metadata = JSON.parse(await readFile("plugins/dsh-gtnh-planner/package.json", "utf8"));
const home = path.resolve(installed.profile);
const scratchRoot = path.resolve("scratch/dsh-installs");
assert.ok(home.startsWith(scratchRoot + path.sep));
const profile = path.join(home, "profiles/web");
const pkg = JSON.parse(
  await readFile(path.join(profile, "node_modules/dsh-gtnh-planner/package.json"), "utf8"),
);
assert.equal(pkg.version, metadata.version, "Install the current tarball before app acceptance");
const host = createRequire(
  path.resolve(
    process.env.GTNH_DSH_MODULE_ROOT ?? path.join(homedir(), ".dsh/profiles/node_modules"),
    "gtnh-app-test.cjs",
  ),
);
const cli = path.join(path.dirname(host.resolve("@deepseek-ai/dsh/package.json")), "lib/bin.js");
const patchPath = path.join(profile, "cordis.patch.yml");
const originalPatch = await readFile(patchPath, "utf8");
const onboarding = await readFile(
  host.resolve("@deepseek-ai/dsh-client-ui-settings-models/client"),
  "utf8",
);
const noticeVersion = onboarding.match(/const WELCOME_NOTICE_VERSION = "([^"]+)"/)[1];
await writeFile(
  patchPath,
  JSON.stringify([
    { id: "locale", config: { preference: "zh" } },
    { id: "ui-settings-models", config: { credentialOnboarding: false } },
    { id: "ui-settings-general", config: { welcomeNoticeVersion: noticeVersion } },
    { id: "ui-settings-account", config: { version: 1, step: "done", completion: "skipped" } },
  ]),
);
const output = path.resolve("scratch/dsh-app");
await mkdir(output, { recursive: true });
const child = spawn(
  process.execPath,
  [cli, "--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
  {
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    log += chunk;
  });
let browser;
let page;
const errors = [];
try {
  const deadline = Date.now() + 60000;
  while (!log.match(/dsh web: (http:\/\/\S+)/)) {
    assert.equal(child.exitCode, null, log.replace(/token=\S+/g, "token=[redacted]"));
    if (Date.now() > deadline) throw Error("Timed out waiting for isolated DSH startup");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const url = log.match(/dsh web: (http:\/\/\S+)/)[1];
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  const welcome = page.getByRole("button", { name: "继续", exact: true });
  const plugins = page.getByRole("button", { name: "插件", exact: true });
  await plugins.waitFor();
  // A new profile may show the SDK preview notice before its first navigation.
  if (await welcome.isVisible()) await welcome.click();
  await plugins.click();
  await page.locator('[data-plugin-package="dsh-gtnh-planner"]').click();
  const settings = page.getByRole("form", { name: "GTNH 服务器连接" });
  await settings.waitFor();
  const field = settings.getByRole("textbox", { name: "服务器地址", exact: true });
  await field.fill("https://planner.example.com");
  await settings.getByRole("button", { name: "保存连接设置" }).click();
  await settings.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  assert.ok((await readFile(patchPath, "utf8")).includes("https://planner.example.com"));
  await page.reload({ waitUntil: "load" });
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await page.locator('[data-plugin-package="dsh-gtnh-planner"]').click();
  assert.equal(
    await page.getByRole("textbox", { name: "服务器地址", exact: true }).inputValue(),
    "https://planner.example.com",
  );
  assert.deepEqual(errors, [], "The full SDK roster must mount without slot ownership conflicts");
  await page.screenshot({ path: path.join(output, "plugin-settings.png"), fullPage: true });
  const report = {
    pass: true,
    package: metadata.version,
    fullDshApp: true,
    pluginDetailSettings: true,
    hostSave: true,
    reloadPersistence: true,
    pageErrors: errors,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    console.log("Isolated DSH page:", await page.locator("body").innerText());
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  }
  throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}`, { cause: error });
} finally {
  await browser?.close();
  child.kill();
  await writeFile(patchPath, originalPatch);
}
