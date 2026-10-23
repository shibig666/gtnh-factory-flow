import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { AgentRelayService } from "../../src/agent-relay/service.ts";
import { loadCertificate } from "./certificate.mjs";
import { help, readConfig } from "./config.mjs";

/** One external listener serves Next.js, pairing HTTP, and the relay WebSocket. */
export async function startProduction(root, config) {
  process.chdir(root);
  process.env.NODE_ENV = "production";
  nextEnv.loadEnvConfig(root, false);
  let buildId;
  try {
    buildId = (await readFile(path.join(root, ".next/BUILD_ID"), "utf8")).trim();
  } catch {
    throw new Error("缺少生产构建。先运行 npm ci 和 npm run build:production。");
  }
  const routes = JSON.parse(await readFile(path.join(root, ".next/routes-manifest.json"), "utf8"));
  const rewrites = Array.isArray(routes.rewrites)
    ? routes.rewrites
    : (routes.rewrites?.beforeFiles ?? []);
  const datasetProxy = rewrites.find((rule) => rule.source === "/api/datasets/:path*")?.destination;
  const configuredBackend = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");
  const localManifest = existsSync(path.join(root, "public/datasets/gtnh/datasets.manifest.json"));
  if (configuredBackend && datasetProxy !== `${configuredBackend}/api/datasets/:path*`)
    throw new Error(
      "配方后端与构建不一致。设置 GTNH_DATASET_BACKEND_URL 后重新运行 npm run build:production。",
    );

  const tls =
    config.protocol === "https"
      ? await loadCertificate(path.resolve(root, config.stateDir), config.publicHost)
      : undefined;
  const proxyToken = randomBytes(32).toString("hex");
  const relay = new AgentRelayService({
    origin: config.origin,
    proxyToken,
    maxRooms: Number(process.env.AGENT_RELAY_MAX_ROOMS ?? 100),
  });
  let app;
  let listener;
  const sockets = new Set();
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      const closed = listener?.listening
        ? new Promise((resolve) => listener.close(resolve))
        : Promise.resolve();
      // Upgraded sockets are not closed by server.close().
      for (const socket of sockets) socket.destroy();
      listener?.closeAllConnections();
      await Promise.allSettled([closed, relay.stop(), app?.close()]);
    })());
  try {
    const relayPort = await relay.start(0, "127.0.0.1");
    process.env.AGENT_RELAY_INTERNAL_URL = `http://127.0.0.1:${relayPort}`;
    process.env.AGENT_RELAY_PROXY_TOKEN = proxyToken;
    process.env.AGENT_PUBLIC_ORIGIN = config.origin;
    // A remote backend owns its dataset cache; a missing local dataset cannot be prewarmed.
    process.env.GTNH_PREWARM_ON_STARTUP ??= datasetProxy || !localManifest ? "0" : "1";
    // Next's environment loader must retain the internally allocated relay address.
    nextEnv.updateInitialEnv(process.env);
    const next = (await import("next")).default;
    app = next({ dev: false, dir: root, hostname: config.publicHost, port: config.port });
    await app.prepare();
    const handle = app.getRequestHandler();
    const handler = (req, res) => {
      req.headers["x-client-ip"] = req.socket.remoteAddress ?? "unknown";
      req.headers["x-forwarded-proto"] = config.protocol;
      if (req.url === "/_server/health") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, origin: config.origin, buildId, relay: true }));
        return;
      }
      // Keep browser and agent on the canonical origin used by the pairing code.
      if (req.headers.host !== new URL(config.origin).host) {
        res.writeHead(307, {
          Location: `${config.origin}${req.url?.startsWith("/") ? req.url : "/"}`,
        });
        res.end();
        return;
      }
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("网页请求失败，请查看服务端日志并刷新页面。");
      });
    };
    listener = tls ? createHttpsServer(tls, handler) : createServer(handler);
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    listener.on("upgrade", (req, socket, head) => {
      if (req.url !== "/agent/ws" || req.headers.host !== new URL(config.origin).host) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = httpRequest({
        hostname: "127.0.0.1",
        port: relayPort,
        path: "/agent/ws",
        headers: {
          ...req.headers,
          "x-agent-proxy-token": proxyToken,
          "x-agent-client-ip": req.socket.remoteAddress ?? "unknown",
        },
      });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        upstream.setTimeout(0);
        remote.setTimeout(0);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`,
        );
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        remote.pipe(socket).pipe(remote);
        remote.on("error", () => socket.destroy());
        socket.on("error", () => remote.destroy());
        socket.once("close", () => remote.destroy());
        remote.once("close", () => socket.destroy());
      });
      upstream.on("response", (response) => {
        response.resume();
        socket.end(`HTTP/1.1 ${response.statusCode} Relay refused\r\nConnection: close\r\n\r\n`);
      });
      upstream.on("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.end();
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(config.port, config.host, () => {
        listener.off("error", reject);
        resolve();
      });
    });
    return { stop, buildId, tls, datasetProxy, localManifest };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const config = await readConfig();
  if (!config) return console.log(help);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(`[server] 正在启动生产服务，监听 ${config.host}:${config.port}…`);
  const running = await startProduction(root, config);
  console.log(`[server] 已就绪：${config.origin}`);
  console.log(`[server] 浏览器、DSH、MCP 请使用同一地址：${config.origin}`);
  console.log(
    `[server] 构建 ${running.buildId}；配方来源：${running.datasetProxy ?? "本地 public/datasets/gtnh"}`,
  );
  if (!running.datasetProxy && !running.localManifest)
    console.warn(
      "[server] 尚未配置配方：放入本地数据集，或设置 GTNH_DATASET_BACKEND_URL 后重新构建。参见 docs/production-server.md。",
    );
  if (config.candidates.length > 1)
    console.log("[server] 检测到多个网卡；地址不合适时使用 --public-host 指定。");
  if (running.tls)
    console.log(`[server] 自签名证书：${running.tls.certPath}。浏览器首次访问需接受证书警告。`);
  else console.log("[server] HTTP 模式：客户端使用兼容的 UUID、图片校验与文本复制路径。");
  console.log("[server] 关闭：Ctrl+C。页面载入旧脚本时使用 Ctrl+Shift+R 强制刷新。");
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const reasons = {
      EADDRINUSE: "端口已被占用，请停止旧服务或选择另一个端口。",
      EADDRNOTAVAIL: "监听 IP 不属于此服务器，请检查网卡或使用 0.0.0.0。",
      EACCES: "端口或证书目录没有访问权限，请更换端口或目录。",
    };
    console.error(`[server] 启动失败：${reasons[error.code] ?? error.message}`);
    process.exitCode = 1;
  });
}
