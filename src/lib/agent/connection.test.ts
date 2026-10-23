import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { connectionMode } from "./connection";
import { createAgentConnection } from "./create-connection";
import { RelayConnection } from "./relay-connection";
import { CONNECTION_GUIDANCE, IMAGE_GUIDANCE } from "./guidance";

describe("shared agent connection contract", () => {
  it("keeps legacy loopback compatible and sends HTTPS to the outbound relay", () => {
    expect(connectionMode("http://localhost:3000")).toBe("local");
    expect(connectionMode("http://[::1]:3000")).toBe("local");
    expect(connectionMode("https://planner.example")).toBe("relay");
    expect(connectionMode("https://localhost")).toBe("relay");
    expect(createAgentConnection("https://planner.example")).toBeInstanceOf(RelayConnection);
    expect(connectionMode("http://127.0.0.1:3000", "relay")).toBe("relay");
    expect(() => createAgentConnection("http://public.example")).toThrow("HTTPS");
    expect(() => connectionMode("https://public.example", "local")).toThrow("loopback");
    expect(() => connectionMode("https://public.example", "invalid" as never)).toThrow("mode");
  });
  it("keeps the skill's connection policy synchronized with both runtime adapters", () => {
    expect(readFileSync("skills/gtnh-production-planner/SKILL.md", "utf8")).toContain(
      CONNECTION_GUIDANCE,
    );
    for (const file of ["plugins/dsh-gtnh-planner/index.mjs", "src/mcp/server.ts"])
      expect(readFileSync(file, "utf8")).toContain("CONNECTION_GUIDANCE");
    expect(readFileSync("skills/gtnh-production-planner/SKILL.md", "utf8")).toContain(
      IMAGE_GUIDANCE,
    );
  });
});
