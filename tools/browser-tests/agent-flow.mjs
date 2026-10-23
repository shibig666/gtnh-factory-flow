import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { PNG } from "pngjs";
import { AgentRelayService } from "../../src/agent-relay/service.ts";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  fixtureRecipes,
  fixtureActions,
  fixtureConstraints,
} from "../../src/lib/agent/__fixtures__/chain.ts";

const relayMode = process.env.AGENT_TEST_RELAY === "1";
const publicHttp = process.env.AGENT_TEST_PUBLIC_HTTP === "1";
const selfSigned = process.env.AGENT_TEST_SELF_SIGNED_HTTPS === "1";
const output = path.resolve(
  `scratch/${process.env.AGENT_TEST_DSH ? "dsh" : "agent"}-${relayMode ? "relay-" : ""}${publicHttp ? "http-" : selfSigned ? "tls-" : ""}browser`,
);
await mkdir(output, { recursive: true });
const recipes = fixtureRecipes.map((recipe) => ({
  ...recipe,
  inputs: recipe.inputs.map((entry) => ({ ...entry, iconPath: "/fixture.svg" })),
  outputs: recipe.outputs.map((entry) => ({ ...entry, iconPath: "/fixture.svg" })),
}));
const resources = [
  ...new Map(
    recipes
      .flatMap((recipe) => [...recipe.inputs, ...recipe.outputs])
      .map((entry) => [entry.id, { ...entry, recipeCount: 1 }]),
  ).values(),
];
const version = {
  id: "fixture-2.9",
  gtnhVersion: "2.9",
  channel: "stable",
  publishedAt: "2026-01-01T00:00:00Z",
  manifestPath: "/datasets/gtnh/fixture-2.9/manifest.json",
  recipeDatasetPath: "/datasets/gtnh/fixture-2.9/recipes.json.gz",
  checksumSha256: "fixture-hash",
  sourceInfo: {
    sourceId: "gtnh-oracle",
    generatedAt: "2026-01-01T00:00:00Z",
    notes: "Artificial integration fixture",
  },
};
const manifest = { schemaVersion: 1, latestStableVersion: version.id, versions: [version] };
const apiPaths = [];
let fingerprint = version.checksumSha256;
let child;
let nextLogs = "";
let browser;
let client;
const pageErrors = [];
const report = { fixture: true };

const portFinder = createServer();
await new Promise((resolve) => portFinder.listen(0, "127.0.0.1", resolve));
const nextPort = portFinder.address().port;
await new Promise((resolve) => portFinder.close(resolve));

const proxyServer = selfSigned
  ? createHttpsServer.bind(null, {
      key: await readFile("src/lib/agent/__fixtures__/tls-key.pem"),
      cert: await readFile("src/lib/agent/__fixtures__/tls-cert.pem"),
    })
  : createServer;
const proxy = proxyServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (process.env.AGENT_TEST_LLM === "claude" && url.pathname === "/test-tools") {
    void client.listTools().then((result) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (process.env.AGENT_TEST_LLM === "claude" && url.pathname === "/test-call") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = JSON.parse(body);
      void client.callTool(params).then((result) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
    });
    return;
  }
  if (url.pathname === "/fixture.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#b87533"/></svg>',
    );
    return;
  }
  const json = (value) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith("/api/datasets/") || url.pathname.startsWith("/datasets/gtnh/")) {
    apiPaths.push(url.pathname);
    if (url.pathname.endsWith("datasets.manifest.json"))
      return json({ ...manifest, versions: [{ ...version, checksumSha256: fingerprint }] });
    if (url.pathname.endsWith("/catalog"))
      return json({
        schemaVersion: 1,
        datasetVersionId: version.id,
        gtnhVersion: "2.9",
        sourceInfo: version.sourceInfo,
        resources: [],
        resourceIndex: resources,
        recipes: [],
        recipeCount: recipes.length,
        oreDictionary: {},
        recipeMaps: recipes.map((recipe) => recipe.machineType),
        generatedAt: version.publishedAt,
      });
    if (url.pathname.endsWith("/recipe-ids"))
      return json({ recipeIds: recipes.map((recipe) => recipe.id) });
    if (url.pathname.endsWith("/resolve-recipes")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () =>
        json({
          matches: JSON.parse(body).recipes.map((recipe) => ({
            importedId: recipe.id ?? recipe.importedId,
            recipeId: recipe.id ?? recipe.importedId,
            exact: true,
          })),
        }),
      );
      return;
    }
    if (url.pathname.includes("/recipes/")) {
      const recipe = recipes.find(
        (entry) => entry.id === decodeURIComponent(url.pathname.split("/").pop()),
      );
      if (!recipe) {
        res.statusCode = 404;
        return json({ error: "Not found" });
      }
      return json(recipe);
    }
    if (url.pathname.endsWith("/resources")) {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const found = resources.filter((entry) =>
        `${entry.id} ${entry.displayName}`.toLowerCase().includes(query),
      );
      const offset = Number(url.searchParams.get("offset") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 20);
      return json({
        resources: found.slice(offset, offset + limit),
        total: found.length,
        offset,
        limit,
        hasMore: offset + limit < found.length,
      });
    }
    if (url.pathname.endsWith("/recipes")) {
      const resourceId = url.searchParams.get("resourceId");
      const side = url.searchParams.get("mode") === "uses" ? "inputs" : "outputs";
      const found = recipes.filter(
        (entry) => !resourceId || entry[side].some((resource) => resource.id === resourceId),
      );
      return json({
        recipes: found.map((recipe) => ({ ...recipe, recipeMap: recipe.machineType })),
        total: found.length,
        offset: 0,
        limit: 20,
        hasMore: false,
        recipeMaps: found.map((recipe) => recipe.machineType),
      });
    }
    if (url.pathname.endsWith("/crops") || url.pathname.endsWith("/mobs"))
      return json({ recipes: [], mobs: [] });
    return json({});
  }
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: nextPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${nextPort}` },
    },
    (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.statusCode = 502;
    res.end("App unavailable");
  });
  req.pipe(upstream);
});
const testHost = publicHttp
  ? Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address
  : "127.0.0.1";
assert.ok(testHost, "A non-loopback IPv4 address is required for public HTTP acceptance");
await new Promise((resolve) => proxy.listen(0, publicHttp ? "0.0.0.0" : "127.0.0.1", resolve));
const origin = `${selfSigned ? "https" : "http"}://${testHost}:${proxy.address().port}`;
let relay;
let relayPort;
const relayBrowserSockets = new Set();
const relayAgentSockets = new Set();
if (relayMode) {
  relay = new AgentRelayService({ origin });
  relayPort = await relay.start(0);
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: relayPort,
      path: request.url,
      headers: request.headers,
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      const peers = request.headers.origin ? relayBrowserSockets : relayAgentSockets;
      peers.add(socket);
      socket.on("close", () => peers.delete(socket));
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket).pipe(remote);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
}

const waitFor = async (predicate, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
};

try {
  child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(nextPort),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        GTNH_PREWARM_ON_STARTUP: "0",
        AGENT_RELAY_INTERNAL_URL: relayMode ? `http://127.0.0.1:${relayPort}` : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (data) => {
    nextLogs += data;
  });
  child.stderr.on("data", (data) => {
    nextLogs += data;
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${nextPort}/api/version`)).ok;
    } catch {
      return false;
    }
  }, "Next.js did not start");
  if (process.env.AGENT_TEST_DSH) {
    const { createDshClient } = await import("../dsh/test-runtime.mjs");
    client = await createDshClient(origin, relayMode ? "relay" : "auto");
    report.dshRuntime = client.runtimeVersion;
    report.nativePlugin = "dsh-gtnh-planner";
  } else {
    client = new Client({ name: "gtnh-browser-acceptance", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist-mcp/main.mjs")],
        env: {
          ...process.env,
          GTNH_PLANNER_URL: origin,
          GTNH_AGENT_TRANSPORT: relayMode ? "relay" : "auto",
        },
        stderr: "pipe",
      }),
    );
  }
  const callRaw = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  const call = async (name, args = {}) => {
    const response = await callRaw(name, args);
    assert.ok(!response.error && response.ok !== false, `${name}: ${JSON.stringify(response)}`);
    return response.value ?? response;
  };
  const getStatus = async () => (await call("get_status")).browser;
  const target = async () => {
    const state = await getStatus();
    return {
      sessionId: state.sessionId,
      designId: state.designId,
      expectedRevision: state.revision,
      dataset: state.dataset,
    };
  };
  const write = async (name, args = {}) =>
    call(name, { ...(await target()), requestId: randomUUID(), ...args });
  const pair = async (page, allowCreate = true) => {
    const code = (await call("begin_pairing")).code;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    if (publicHttp)
      await page.getByRole("alert").filter({ hasText: "HTTP does not encrypt" }).waitFor();
    await page.getByLabel("Agent pairing code").fill(code);
    if (relayMode)
      await page.getByLabel("Allow new designs in this session").setChecked(allowCreate);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await waitFor(async () => (await call("get_status")).connected, "Browser did not pair");
    await waitFor(async () => Boolean((await getStatus()).dataset), "Dataset did not load");
    await page.keyboard.press("Escape");
  };
  browser = await chromium.launch({
    headless: true,
    ...(publicHttp ? { args: ["--no-proxy-server"] } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: selfSigned,
  });
  await context.addInitScript(() =>
    localStorage.setItem("gtnh-factory-flow.mod-announcement-dismissed.v1", "1"),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await pair(page);
  if (publicHttp) {
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.deepEqual(await page.evaluate(() => [typeof crypto.randomUUID, typeof crypto.subtle]), [
      "undefined",
      "undefined",
    ]);
    assert.equal((await call("get_status")).securityWarnings[0].code, "HTTP_UNENCRYPTED");
    report.publicHttpWithWarning = true;
  }
  if (selfSigned) {
    assert.ok(
      (await call("get_status")).securityWarnings.some(
        (warning) => warning.code === "TLS_UNTRUSTED",
      ),
    );
    report.untrustedTlsWithWarning = true;
  }
  const initial = await getStatus();
  await call("create_design", {
    sessionId: initial.sessionId,
    expectedRevision: initial.revision,
    dataset: initial.dataset,
    requestId: randomUUID(),
    name: "Agent acceptance",
  });
  await call("search_resources", { versionId: version.id, query: "wire" });
  const found = await call("search_recipes", {
    versionId: version.id,
    resource: { kind: "item", id: "fixture:wire" },
  });
  assert.equal(found.recipes[0].id, "fixture:wire");
  const inputState = await target();
  const requestId = randomUUID();
  const added = await call("apply_design_actions", {
    ...inputState,
    requestId,
    actions: fixtureActions,
  });
  assert.equal(added.persisted, true);
  const current = await call("get_design", { ...(await target()), detail: "planning" });
  assert.equal(current.project.nodes.length, 2);
  assert.equal((await page.locator(".react-flow__node").count()) >= 4, true);
  const repeated = await call("apply_design_actions", {
    ...inputState,
    requestId,
    actions: fixtureActions,
  });
  assert.deepEqual(repeated.refs, added.refs);
  assert.equal((await call("get_design", { ...(await target()) })).project.nodes.length, 2);
  const evaluated = await call("evaluate_design", {
    ...(await target()),
    constraints: fixtureConstraints,
  });
  assert.equal(evaluated.complete, true, JSON.stringify(evaluated.issues));
  const stale = await callRaw("apply_design_actions", {
    ...inputState,
    requestId: randomUUID(),
    actions: [{ type: "remove_entity", entityId: added.refs.wiremill }],
  });
  assert.equal(stale.error?.code ?? stale.error?.code, "REVISION_CONFLICT");
  const invalid = await callRaw("apply_design_actions", {
    ...(await target()),
    requestId: randomUUID(),
    actions: [
      {
        type: "update_machine",
        nodeId: added.refs.wiremill,
        settings: { overclockTier: "invented" },
      },
    ],
  });
  assert.equal(invalid.ok, false);
  assert.equal((await call("get_design", { ...(await target()) })).project.nodes.length, 2);
  const changed = await write("apply_design_actions", {
    actions: [{ type: "set_drawer_rule", drawerId: added.refs.product, rate: 4, rule: "exact" }],
  });
  assert.equal(changed.persisted, true);
  const larger = {
    ...fixtureConstraints,
    targets: [{ ...fixtureConstraints.targets[0], perSecond: 4 }],
    allowedInputs: [{ resource: { kind: "item", id: "fixture:dust" }, maxPerSecond: 2 }],
  };
  assert.equal(
    (await call("evaluate_design", { ...(await target()), constraints: larger })).complete,
    true,
  );
  await write("undo_design");
  assert.equal(
    (await call("get_design", { ...(await target()) })).project.storages.find(
      (entry) => entry.id === added.refs.product,
    ).targetPerSecond,
    2,
  );
  await write("redo_design");
  await write("arrange_design");
  const imageTarget = await target();
  const imageResult = await client.callTool({
    name: "export_design_image",
    arguments: imageTarget,
  });
  assert.ok(!imageResult.isError, JSON.stringify(imageResult));
  let imageBytes;
  if (process.env.AGENT_TEST_DSH) {
    const native = imageResult.structuredContent;
    assert.ok(
      imageResult.content.some(
        (part) =>
          part.type === "image" && part.attachment.attachmentId === native.image.attachmentId,
      ),
    );
    imageBytes = await readFile(native.filePath);
    assert.equal(imageBytes.length, native.bytes);
    assert.ok((await client.ctx.attachments.readImage(native.image)).data.length);
    report.chatImageAttachment = native.image.attachmentId;
  } else {
    const content = imageResult.content.find((part) => part.type === "image");
    assert.equal(content.mimeType, "image/png");
    imageBytes = Buffer.from(content.data, "base64");
    assert.equal(imageResult.structuredContent.data, undefined);
  }
  const rendered = PNG.sync.read(imageBytes);
  assert.ok(rendered.width > 100 && rendered.height > 100);
  assert.equal((await target()).expectedRevision, imageTarget.expectedRevision);
  await writeFile(path.join(output, "exported-flowchart.png"), imageBytes);
  report.exportedImage = {
    width: rendered.width,
    height: rendered.height,
    bytes: imageBytes.length,
  };
  const exported = await call("export_design", await target());
  assert.equal(JSON.parse(exported.json).nodes.length, 2);
  const originalDesignId = exported.designId;
  const stressStatus = await getStatus();
  await call("create_design", {
    sessionId: stressStatus.sessionId,
    expectedRevision: stressStatus.revision,
    dataset: stressStatus.dataset,
    requestId: randomUUID(),
    name: "Agent performance",
  });
  const stressActions = Array.from({ length: 25 }, (_, index) =>
    fixtureActions.map((original) => {
      const action = structuredClone(original);
      const prefix = (value) => `chain-${index}-${value}`;
      if (action.ref) action.ref = prefix(action.ref);
      if (action.source) action.source.entityId = prefix(action.source.entityId);
      if (action.target) action.target.entityId = prefix(action.target.entityId);
      return action;
    }),
  ).flat();
  await write("apply_design_actions", { actions: stressActions });
  const stressConstraints = {
    ...fixtureConstraints,
    targets: [{ ...fixtureConstraints.targets[0], perSecond: 50 }],
    allowedInputs: [{ resource: { kind: "item", id: "fixture:dust" }, maxPerSecond: 25 }],
  };
  assert.equal(
    (await call("evaluate_design", { ...(await target()), constraints: stressConstraints }))
      .complete,
    true,
  );
  report.stressCards = 100;
  report.stressEdges = 75;
  if (relayMode) {
    const stale = await target();
    for (const peer of relayBrowserSockets) peer.destroy();
    await waitFor(
      async () => !(await call("get_status")).connected,
      "Browser interruption was not detected",
    );
    await page.keyboard.press("Control+z");
    await waitFor(
      async () => (await call("get_status")).connected,
      "Browser did not reconnect to its grant",
    );
    await waitFor(
      async () => (await getStatus()).revision > stale.expectedRevision,
      "Offline manual edits did not advance the revision",
    );
    const rejected = await callRaw("apply_design_actions", {
      ...stale,
      requestId: randomUUID(),
      actions: [{ type: "remove_entity", entityId: "unused" }],
    });
    assert.equal(rejected.error?.code, "REVISION_CONFLICT");
    await page.keyboard.press("Control+Shift+z");
    await waitFor(
      async () => (await call("get_design", { ...(await target()) })).project.counts.nodes === 50,
      "Redo did not restore the stress design",
    );
    for (const peer of relayAgentSockets) peer.destroy();
    await waitFor(
      async () => !(await call("get_status")).connected,
      "Agent interruption was not detected",
    );
    await waitFor(
      async () => (await call("get_status")).connected,
      "Agent did not reconnect to its grant",
    );
    assert.equal(
      (await call("evaluate_design", { ...(await target()), constraints: stressConstraints }))
        .complete,
      true,
    );
    report.browserReconnect = true;
    report.agentReconnect = true;
    report.offlineRevisionGuard = true;
  }
  const profile = async (label) => {
    // Let the camera animation and the most recent solve settle before comparing idle/hover cost.
    await page.waitForTimeout(750);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const wrapper = await page.locator(".react-flow").boundingBox();
    if (wrapper)
      for (let i = 0; i < 30; i++)
        await page.mouse.move(
          wrapper.x + 30 + (i % 10) * 35,
          wrapper.y + 40 + Math.floor(i / 10) * 80,
        );
    const timing = await page.evaluate(async () => {
      const start = performance.now();
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      return performance.now() - start;
    });
    const { profile: cpu } = await cdp.send("Profiler.stop");
    await writeFile(path.join(output, `${label}.cpuprofile`), JSON.stringify(cpu));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
    return timing;
  };
  report.connectedFrameMs = await profile("connected");
  const announcementDismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  if (await announcementDismiss.isVisible()) await announcementDismiss.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await page.screenshot({ path: path.join(output, "agent-panel.png"), fullPage: false });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.keyboard.press("Escape");
  report.disconnectedFrameMs = await profile("disconnected");
  await page.reload({ waitUntil: "load" });
  if (relayMode) await page.locator(`[data-design-id="${originalDesignId}"]`).click();
  await pair(page);
  await call("open_design", {
    ...(await target()),
    designId: originalDesignId,
    requestId: randomUUID(),
  });
  const restored = await call("get_design", { ...(await target()) });
  assert.equal(restored.project.nodes.length, 2);
  assert.equal(
    restored.project.storages.find((entry) => entry.id === added.refs.product).targetPerSecond,
    4,
  );
  await page.screenshot({ path: path.join(output, "agent-board.png"), fullPage: false });
  if (process.env.AGENT_TEST_LLM === "claude") {
    const configPath = path.join(output, "llm-mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          gtnh: {
            command: process.execPath,
            args: [path.resolve("tools/browser-tests/agent-client-relay.mjs")],
            env: { AGENT_TEST_RELAY_URL: origin },
          },
        },
      }),
    );
    const skill = await readFile("skills/gtnh-production-planner/SKILL.md", "utf8");
    const tools = (await client.listTools()).tools
      .map((tool) => `mcp__gtnh__${tool.name}`)
      .filter((name) => name !== "mcp__gtnh__begin_pairing");
    const task =
      "Acceptance test with an artificial dataset. Use the gtnh MCP and the supplied skill to create a NEW design named LLM acceptance producing exactly 2 Fixture Wire per second. Maximum tier LV; only Fixture Dust may be externally supplied, unlimited. Electricity is external. Discover the actual item and recipe IDs through the API, recursively plan every intermediate, construct and wire the whole chain, evaluate all constraints, and arrange it. Do not alter the existing design, use the shell, read local dataset files, or ask questions; all constraints are specified. The browser is already paired. Finish only after evaluate_design reports complete=true, or clearly report failure. Report the design ID and evaluation result.";
    let stdout = "",
      stderr = "";
    const agent = spawn(
      "claude",
      [
        "-p",
        task,
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--allowedTools",
        ...tools,
        "--append-system-prompt",
        skill,
        "--output-format",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    agent.stdout.on("data", (data) => {
      stdout += data;
    });
    agent.stderr.on("data", (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => agent.kill(), 240_000);
    const exitCode = await new Promise((resolve, reject) => {
      agent.on("error", reject);
      agent.on("exit", resolve);
    });
    clearTimeout(timer);
    await writeFile(path.join(output, "llm-result.json"), stdout);
    await writeFile(path.join(output, "llm-stderr.log"), stderr);
    await unlink(configPath);
    assert.equal(exitCode, 0, stderr);
    const llmDesign = await call("get_design", { ...(await target()) });
    assert.equal(llmDesign.project.name, "LLM acceptance");
    assert.equal(llmDesign.project.counts?.nodes ?? llmDesign.project.nodes.length, 2);
    const verified = await call("evaluate_design", {
      ...(await target()),
      constraints: fixtureConstraints,
    });
    assert.equal(verified.complete, true, JSON.stringify(verified.issues));
    report.llmPlanning = { client: "Claude Code", designId: llmDesign.designId, complete: true };
  }
  fingerprint = "changed-fingerprint";
  const mismatch = await callRaw("apply_design_actions", {
    ...(await target()),
    requestId: randomUUID(),
    actions: [{ type: "remove_entity", entityId: added.refs.wiremill }],
  });
  assert.equal(mismatch.error?.code, "DATASET_CHANGED");
  if (relayMode) {
    fingerprint = version.checksumSha256;
    await pair(page, false);
    const granted = await call("list_designs");
    assert.deepEqual(
      granted.designs.map((entry) => entry.id),
      [originalDesignId],
    );
    const { designId: _designId, ...createTarget } = await target();
    const denied = await callRaw("create_design", {
      ...createTarget,
      requestId: randomUUID(),
      name: "Not authorized",
    });
    assert.equal(denied.error?.code ?? denied.result?.error?.code, "PERMISSION_DENIED");
    await page.getByRole("tab", { name: "Agent performance", exact: false }).click();
    await waitFor(
      async () => !(await call("get_status")).connected,
      "Switching to an ungranted design did not revoke pairing",
    );
    report.designIsolation = true;
    report.createPermission = true;
    report.switchRevocation = true;
  }
  report.apiRequests = apiPaths.length;
  report.pageErrors = pageErrors;
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  report.pass = true;
  console.log(
    "PASS: real app pairing, HTTP queries, atomic edits, solver constraints, idempotence, revision conflicts, undo/redo, arrange, export, refresh persistence and dataset mismatch.",
  );
} catch (error) {
  report.error = error.stack;
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages[0]) {
      report.visibleText = await pages[0]
        .locator("body")
        .innerText()
        .catch(() => "");
      await pages[0].screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined);
    }
  }
  throw error;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, "next.log"), nextLogs);
  await client?.close();
  await browser?.close();
  await relay?.stop();
  await new Promise((resolve) => proxy.close(resolve));
  child?.kill();
}
