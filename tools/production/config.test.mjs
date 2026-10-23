import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.mjs";

const interfaces = { lan: [{ address: "192.168.1.20", family: "IPv4", internal: false }] };
const input = { host: "0.0.0.0", protocol: "http", port: "8080" };

describe("production listening options", () => {
  it("separates the wildcard listener from the reachable pairing origin", () => {
    expect(resolveConfig(input, interfaces)).toMatchObject({
      host: "0.0.0.0",
      origin: "http://192.168.1.20:8080",
    });
    expect(
      resolveConfig({ ...input, protocol: "https", "public-host": "planner.lan" }, interfaces),
    ).toMatchObject({ origin: "https://planner.lan:8080" });
    expect(resolveConfig({ host: "[::1]", protocol: "https", port: "443" }, {})).toMatchObject({
      host: "::1",
      origin: "https://[::1]",
    });
  });

  it("rejects unreachable origins and invalid arguments before opening a listener", () => {
    for (const changed of [
      { protocol: "ftp" },
      { port: "0" },
      { port: "65536" },
      { port: "80abc" },
      { "public-host": "http://192.168.1.20:8080" },
      { "public-host": "0.0.0.0" },
      { host: "127.0.0.1", "public-host": "192.168.1.20" },
    ])
      expect(() => resolveConfig({ ...input, ...changed }, interfaces)).toThrow();
    expect(() => resolveConfig(input, {})).toThrow();
  });
});
