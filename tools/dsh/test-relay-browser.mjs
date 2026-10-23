process.env.AGENT_TEST_DSH = "1";
process.env.AGENT_TEST_RELAY = "1";
await import("../browser-tests/agent-flow.mjs");
