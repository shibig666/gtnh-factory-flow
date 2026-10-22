import { createInterface } from "node:readline";

// Test-only stdio relay lets a real agent use the already-paired fixture session.
const origin = new URL(process.env.AGENT_TEST_RELAY_URL);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
  throw new Error("A loopback test origin is required.");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "gtnh-fixture-relay", version: "1.0.0" },
      };
    else if (request.method === "tools/list")
      result = await (await fetch(new URL("/test-tools", origin))).json();
    else if (request.method === "tools/call")
      result = await (
        await fetch(new URL("/test-call", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.params),
        })
      ).json();
    else if (request.method === "ping") result = {};
    else {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported test method" } })}\n`,
      );
      continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    console.error(error.message);
  }
}
