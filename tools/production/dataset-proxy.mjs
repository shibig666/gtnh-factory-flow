import { pipeline } from "node:stream/promises";
import { Agent, EnvHttpProxyAgent, request } from "undici";

const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function endToEndHeaders(headers) {
  const result = { ...headers };
  const connection = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connection]) delete result[name];
  return result;
}

export function proxyDescription(env = process.env, setting = { mode: "env" }) {
  if (setting.mode === "direct") return "已关闭（不使用环境代理）";
  const http = setting.mode === "explicit" ? setting.url : (env.http_proxy ?? env.HTTP_PROXY);
  const https =
    setting.mode === "explicit" ? setting.url : (env.https_proxy ?? env.HTTPS_PROXY) || http;
  const describe = (value) => {
    if (!value) return "直连";
    try {
      return new URL(value).origin;
    } catch {
      return "无效代理地址";
    }
  };
  return `HTTP=${describe(http)}；HTTPS=${describe(https)}；遵循 NO_PROXY/no_proxy`;
}

/** Only the configured dataset backend uses proxy environment variables. */
export class DatasetProxy {
  constructor(backend, options = {}) {
    this.backend = backend.replace(/\/+$/, "");
    const url = new URL(this.backend);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
      throw new Error("配方后端必须是 HTTP(S) 地址，不包含查询参数或片段。");
    const setting = options.proxy ?? { mode: "env" };
    this.dispatcher =
      options.dispatcher ??
      (setting.mode === "direct"
        ? new Agent({ connect: { timeout: 10000 } })
        : new EnvHttpProxyAgent(
            setting.mode === "explicit" ? { httpProxy: setting.url, httpsProxy: setting.url } : {},
          ));
  }

  handles(url = "") {
    const pathname = url.split("?")[0];
    return pathname.startsWith("/api/datasets/") || pathname.startsWith("/datasets/gtnh/");
  }

  async forward(req, res) {
    if (!this.handles(req.url)) throw new Error("Not a dataset request");
    const controller = new AbortController();
    const interrupted = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.once("aborted", interrupted);
    res.once("close", interrupted);
    try {
      const headers = endToEndHeaders(req.headers);
      delete headers.host;
      const upstream = await request(`${this.backend}${req.url}`, {
        dispatcher: this.dispatcher,
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        headersTimeout: 30000,
        bodyTimeout: 30000,
      });
      // request() streams encoded bytes, so gzip, image and length headers remain accurate.
      res.writeHead(upstream.statusCode, endToEndHeaders(upstream.headers));
      await pipeline(upstream.body, res);
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      console.error(
        `[server] 配方后端连接失败 (${error.code ?? error.name})；检查服务器外网及 HTTP(S)_PROXY/NO_PROXY。`,
      );
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: {
            code: "DATASET_BACKEND_UNAVAILABLE",
            message: "配方后端连接失败，请检查服务器的外网连接及 HTTP(S)_PROXY/NO_PROXY 配置。",
          },
        }),
      );
    } finally {
      req.off("aborted", interrupted);
      res.off("close", interrupted);
    }
  }

  close() {
    return this.dispatcher.destroy();
  }
}
