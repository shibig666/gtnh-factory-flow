# Agent integration

These rules cover `src/lib/agent`, `src/agent-relay`, `src/mcp`,
`src/app/api/agent`, `AgentConnectionPanel`, `plugins/dsh-gtnh-planner` and
`skills/gtnh-production-planner`.

- Both adapters delegate to `createPlannerTools` and `createAgentConnection`.
  Change schemas, recipe compaction, validation and transport behavior in the
  shared core. Keep the DSH package native: no MCP runtime or filesystem skill
  provider in its dependency graph.
- A workflow change updates the native prompt and companion skill together.
  `CONNECTION_GUIDANCE` is shared by both runtime adapters and pinned against the
  skill. Update the plugin README, MCP guide and relay guide when setup changes.
- Relay clients only dial the configured website. Public origins require HTTPS;
  HTTP loopback supports explicit relay testing and the legacy local bridge.
  Recipe authority remains the configured site's API, never direct dataset files.
- Pairing codes carry no device credential and approve once. Browser and agent
  tokens are separate, scoped to a session and granted designs, and memory-only.
  New designs require explicit consent. Unrelated designs are never enumerated.
- The webpage remains the editor, canonical recipe loader, solver and saver.
  Preserve revision and dataset checks, atomic batches and guarded IndexedDB
  persistence. Do not bypass cloud/live leases or claim offline planning support.
- Connection loss or cancellation may follow an applied edit. Never replay writes
  on reconnect; report unknown outcomes and inspect current state. Track browser
  revisions while disconnected and isolate receipts by pairing.
- Bound public-service state, command queues, frames and receipt caches. Do not
  log tokens, pairing request bodies or WebSocket frames. No new public client
  listening ports.

Verification: `npm run typecheck`, `npm test`, `npm run build:mcp`,
`npm run build:dsh`, `npm run build:agent-relay`, `npm run build`.
Run both `test:agent:browser` and `test:dsh:browser` for local compatibility, and
`test:agent:relay:browser` and `test:dsh:relay:browser` for relay changes.
The native SDK and isolated installer checks are `test:dsh` and
`test:dsh:install`. Browser fixtures are artificial and do not prove a gameplay
recipe or an LLM's autonomous planning quality. Keep captures under `scratch/`.

Deployment templates and current scope: `docs/agent-relay.md`. A build or push
does not authorize deployment.
