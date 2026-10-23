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
modules["dsh-gtnh-planner"].apply({ slots });
const view = seats.get("gtnh_export_design_image");
if (view.spec.children["tool.call.images"].scope !== "session") throw Error("Image gallery must be session scoped");
const t = (key) => key;
const renderFactorySlot = (name, props) => React.createElement(factories.get(name), { ...props, t });
const renderSlot = (name, props) => React.createElement(seats.get(name).component, { ...props, renderFactorySlot });
const block = { isError: false, content: [{ type: "text", text: ${JSON.stringify(JSON.stringify(metadata))} }, { type: "image", attachment: ${JSON.stringify(ref)} }] };
const root = createRoot(document.getElementById("root"));
root.render(React.createElement(view.component, { phase: "result", block, renderSlot, loadImage: async (attachment) => { if (attachment.attachmentId !== "test-durable-image") throw Error("Wrong attachment"); return "data:image/png;base64,${png.toString("base64")}"; }, openFile: (file) => { window.__opened = file; } }));
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
  const report = {
    pass: true,
    sdkGallery: "@deepseek-ai/dsh-client-ui-attachment",
    package: installation.metadata.version,
    width: dimensions.width,
    height: dimensions.height,
    imageVisible: true,
    originalFileAction: true,
    pageErrors: errors,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  installation.release();
}
