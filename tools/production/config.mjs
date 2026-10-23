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
  --help         Show this help

Build first: npm ci && npm run build:production
With no arguments, an interactive terminal asks for the three listening options.
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
  return {
    host,
    protocol,
    port,
    publicHost,
    origin: new URL(`${protocol}://${authority}:${port}`).origin,
    stateDir: values["state-dir"] ?? ".runtime/production",
    candidates,
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
    } finally {
      terminal.close();
    }
  }
  return resolveConfig(values);
}
