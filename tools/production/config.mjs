import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

export const help = `GTNH production server

  npm run serve -- --host 0.0.0.0 --protocol http --port 8080
  npm run serve -- --host 0.0.0.0 --protocol https --port 8443 --public-host 192.168.1.10

Options:
  --host         Listening IP address (prompted when omitted)
  --protocol     http or https, with an automatically generated self-signed certificate
  --port         Public port, 1-65535 (prompted when omitted)
  --public-host  Browser/plugin hostname or IP; auto-detected for wildcard listeners
  --state-dir    Certificate directory; defaults to .runtime/production
  --proxy        HTTP(S) proxy URL for recipe data; an empty value disables proxying
  --no-proxy     Disable recipe proxying even when environment variables are set
  --help         Show this help

Build first: npm ci && npm run build:production
With no arguments, an interactive terminal asks for listening options and an optional proxy URL.
With complete CLI listening options, omitted proxy flags use HTTP(S)_PROXY/NO_PROXY.
Browser, DSH and MCP must use the same printed URL, never 0.0.0.0.
`;

function normalizeHost(value) {
  const host = value.trim().replace(/^\[([^\]]+)\]$/, "$1");
  if (isIP(host)) return host;
  if (
    !host ||
    host.length > 253 ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  )
    throw new Error("地址只能包含 IP 或主机名，不要填写协议、路径或端口。");
  return host.toLowerCase();
}

export function resolveConfig(values, interfaces = networkInterfaces()) {
  const host = normalizeHost(values.host ?? "");
  if (!isIP(host) && host !== "localhost")
    throw new Error("监听地址请填写 IP 或 localhost；访问域名使用 --public-host。");
  const protocol = values.protocol?.toLowerCase();
  if (!["http", "https"].includes(protocol)) throw new Error("协议必须为 http 或 https。");
  if (!/^\d+$/.test(values.port ?? "")) throw new Error("端口必须是 1-65535 的整数。");
  const port = Number(values.port);
  if (port < 1 || port > 65535) throw new Error("端口必须是 1-65535 的整数。");
  const wildcard = host === "0.0.0.0" || host === "::";
  const candidates = Object.values(interfaces)
    .flat()
    .filter((entry) => entry && !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address);
  const publicHost = normalizeHost(
    values["public-host"] ?? (wildcard ? (candidates[0] ?? "") : host),
  );
  if (["0.0.0.0", "::"].includes(publicHost))
    throw new Error("访问地址不能是 0.0.0.0 或 ::，请使用 --public-host 指定局域网 IP。");
  // A listener bound to one IP cannot serve a different IP, even on the same machine.
  if (!wildcard && isIP(host) && isIP(publicHost) && host !== publicHost)
    throw new Error("访问 IP 与监听 IP 不同；请改用 0.0.0.0、:: 或相同的 IP。");
  const authority = isIP(publicHost) === 6 ? `[${publicHost}]` : publicHost;
  if (values["no-proxy"] && values.proxy !== undefined)
    throw new Error("--proxy 与 --no-proxy 不能同时设置。");
  let proxy = { mode: "env" };
  if (values["no-proxy"] || values.proxy?.trim() === "") proxy = { mode: "direct" };
  else if (values.proxy !== undefined) {
    let url;
    try {
      url = new URL(values.proxy.trim());
    } catch {
      /* Report the same validation message. */
    }
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("代理地址请填写完整的 http:// 或 https://地址和端口，或留空关闭代理。");
    proxy = { mode: "explicit", url: url.href };
  }
  return {
    host,
    protocol,
    port,
    publicHost,
    origin: new URL(`${protocol}://${authority}:${port}`).origin,
    stateDir: values["state-dir"] ?? ".runtime/production",
    candidates,
    proxy,
  };
}

export async function readConfig(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string" },
      protocol: { type: "string" },
      port: { type: "string" },
      "public-host": { type: "string" },
      "state-dir": { type: "string" },
      proxy: { type: "string" },
      "no-proxy": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return null;
  const missing = ["host", "protocol", "port"].filter((key) => !values[key]);
  if (missing.length) {
    if (!process.stdin.isTTY)
      throw new Error(`非交互运行需提供 ${missing.map((key) => `--${key}`).join("、")}。`);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const questions = {
      host: "监听地址（例如 0.0.0.0）：",
      protocol: "协议（http / https，自签名）：",
      port: "端口（例如 8080）：",
    };
    try {
      for (const key of missing) values[key] = (await terminal.question(questions[key])).trim();
      if (values.proxy === undefined && !values["no-proxy"])
        values.proxy = (
          await terminal.question("代理服务器地址（例如 http://10.126.126.2:7890，留空不启用）：")
        ).trim();
    } finally {
      terminal.close();
    }
  }
  return resolveConfig(values);
}
