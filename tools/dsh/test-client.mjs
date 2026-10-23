import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { installTestPackage } from "./test-runtime.mjs";

const host = createRequire(
  path.resolve(
    process.env.GTNH_DSH_MODULE_ROOT ?? path.join(homedir(), ".dsh/profiles/node_modules"),
    "gtnh-client-test.cjs",
  ),
);
const installation = await installTestPackage();
const output = path.resolve("scratch/dsh-client");
await mkdir(output, { recursive: true });
const galleryFile = host.resolve("@deepseek-ai/dsh-client-ui-attachment/client");
const gallery = await readFile(galleryFile, "utf8");
const plugin = await readFile(path.join(installation.packageRoot, "lib/client.js"), "utf8");
let png;
try {
  png = await readFile("scratch/dsh-relay-browser/exported-flowchart.png");
} catch {
  const raster = new PNG({ width: 160, height: 100 });
  raster.data.fill(180);
  png = PNG.sync.write(raster);
}
const dimensions = PNG.sync.read(png);
const ref = {
  attachmentId: "test-durable-image",
  mediaType: "image/png",
  bytes: png.length,
  width: dimensions.width,
  height: dimensions.height,
  name: "Factory.png",
};
const metadata = {
  name: ref.name,
  width: ref.width,
  height: ref.height,
  filePath: "/test/Factory.png",
};
const bootstrap = `
import React from ${JSON.stringify(host.resolve("react"))};
import * as jsx from ${JSON.stringify(host.resolve("react/jsx-runtime"))};
import * as ReactDOM from ${JSON.stringify(host.resolve("react-dom"))};
import { createRoot } from ${JSON.stringify(host.resolve("react-dom/client"))};
const modules = { react: React, "react/jsx-runtime": jsx, "react-dom": ReactDOM };
// Icons and the unopened lightbox are chrome; the image loader and gallery below are the shipped SDK implementation.
modules["@deepseek-ai/dsh-client-ui-primitives"] = new Proxy({}, { get: (_, name) => name === "ImageLightbox" ? () => null : () => React.createElement("span") });
window.__ModuleLoader__ = { load: ({ id, factory }) => { modules[id] = factory((name) => { if (!(name in modules)) throw Error(name); return modules[name]; }); } };
${gallery}
${plugin}
const seats = new Map(); const factories = new Map();
const slots = { inject: (_name, register) => register(), register: (spec, component) => { seats.set(spec.key ?? spec.name, { spec, component }); return () => {}; }, registerFactory: (spec, component) => { factories.set(spec.name, component); return () => {}; } };
modules["@deepseek-ai/dsh-client-ui-attachment"].apply({ slots });
// Exercise the configuration UI contract; the separate settings test uses the real
// host ConfigEditor, profile persistence and Loader volatile update path.
let snapshot = { status: "ready", value: { plannerUrl: "http://localhost:3000", connectionMode: "auto" }, revision: 1, writable: true };
const listeners = new Set();
const form = { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  mutate: async (ops, revision) => {
    window.__writes = (window.__writes ?? 0) + 1;
    if (window.__refuse || revision !== snapshot.revision) return false;
    if (window.__fail) throw Error("测试：网络连接中断");
    snapshot = { ...snapshot, value: Object.fromEntries(ops.map((op) => [op.path[0], op.value])), revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
    return true;
  }
};
modules["dsh-gtnh-planner"].apply({ slots, configForms: { get: (id) => { if (id !== "gtnh-planner") throw Error(id); return form; } } });
window.__snapshot = () => snapshot;
const view = seats.get("gtnh_export_design_image");
if (view.spec.children) throw Error("The plugin must reuse the SDK gallery Factory without redeclaring its owned slots");
const t = (key) => key;
const renderFactorySlot = (name, props) => React.createElement(factories.get(name), { ...props, t });
const renderSlot = (name, props) => React.createElement(seats.get(name).component, { ...props, renderFactorySlot });
const block = { isError: false, content: [{ type: "text", text: ${JSON.stringify(JSON.stringify(metadata))} }, { type: "image", attachment: ${JSON.stringify(ref)} }] };
const root = createRoot(document.getElementById("root"));
root.render(React.createElement(view.component, { phase: "result", block, renderFactorySlot, loadImage: async (attachment) => { if (attachment.attachmentId !== "test-durable-image") throw Error("Wrong attachment"); return "data:image/png;base64,${png.toString("base64")}"; }, openFile: (file) => { window.__opened = file; } }));
window.__settings = () => {
  const settings = seats.get("dsh-gtnh-planner");
  if (settings.spec.name !== "plugins.bundle.config") throw Error("Settings must appear in the package detail page");
  root.render(React.createElement(settings.component, { view: "page" }));
};
`;
const bundled = await build({
  stdin: { contents: bootstrap, resolveDir: process.cwd() },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  logLevel: "warning",
});
const code = bundled.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(code);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><body><main id="root"></main><script src="/client.js"></script></body></html>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
  await page.getByRole("region", { name: "GTNH flowchart image" }).waitFor();
  await page.waitForFunction(() =>
    [...document.images].some((img) => img.complete && img.naturalWidth > 0),
  );
  await page.getByRole("button", { name: "Open full PNG" }).click();
  assert.equal(await page.evaluate(() => window.__opened), metadata.filePath);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "image-card.png") });
  await page.evaluate(() => window.__settings());
  const url = page.getByRole("textbox", { name: "服务器地址", exact: true });
  const mode = page.getByRole("combobox", { name: "连接模式", exact: true });
  const save = page.getByRole("button", { name: "保存连接设置" });
  await url.waitFor();
  assert.equal(await url.inputValue(), "http://localhost:3000");
  assert.equal(await save.isDisabled(), true);
  await url.fill("http://planner.example.com");
  await mode.selectOption("relay");
  await page.getByRole("alert").filter({ hasText: "HTTP 不加密" }).waitFor();
  await save.click();
  await page.getByText("已保存。旧连接已关闭", { exact: false }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.__snapshot())).value.plannerUrl,
    "http://planner.example.com",
  );
  const acceptedWrites = await page.evaluate(() => window.__writes);
  await url.fill("https://planner.example.com/path");
  await save.click();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.__writes), acceptedWrites);
  await url.fill("https://planner.example.com/");
  await mode.selectOption("relay");
  await save.click();
  await page.getByText("已保存。旧连接已关闭", { exact: false }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__snapshot())).value, {
    plannerUrl: "https://planner.example.com",
    connectionMode: "relay",
  });
  await url.fill("https://second.example.com");
  await page.evaluate(() => {
    window.__refuse = true;
  });
  await save.click();
  await page.getByRole("alert").filter({ hasText: "保存被拒绝" }).waitFor();
  assert.equal(await url.inputValue(), "https://second.example.com");
  await page.getByRole("button", { name: "重新读取" }).click();
  assert.equal(await url.inputValue(), "https://planner.example.com");
  await page.evaluate(() => {
    window.__refuse = false;
    window.__fail = true;
  });
  await url.fill("https://second.example.com");
  await save.click();
  await page.getByRole("alert").filter({ hasText: "网络连接中断" }).waitFor();
  assert.equal(await url.inputValue(), "https://second.example.com");
  await page.screenshot({ path: path.join(output, "connection-settings.png") });
  assert.deepEqual(errors, []);
  const report = {
    pass: true,
    sdkGallery: "@deepseek-ai/dsh-client-ui-attachment",
    package: installation.metadata.version,
    width: dimensions.width,
    height: dimensions.height,
    imageVisible: true,
    originalFileAction: true,
    packageDetailSettings: true,
    validatedAtomicSave: true,
    httpAcceptedWithWarning: true,
    refusedSavePreservesDraft: true,
    failedSavePreservesDraft: true,
    pageErrors: errors,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  installation.release();
}
