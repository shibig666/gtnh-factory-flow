# GTNH Factory Flow MCP

The MCP server exposes recipe discovery and a paired local canvas. The companion skill guides a client through target-driven recipe selection, graph construction and solver validation. The server does not run another LLM or need a separate model API key.

## Start

Use Node.js 20 or newer (CI uses 24). In the repository:

```sh
npm ci
npm run build:mcp
npm run dev
```

Set `GTNH_DATASET_BACKEND_URL=https://gtnhplanner.com` on the **web application** if local dataset files are absent. In PowerShell:

```powershell
$env:GTNH_DATASET_BACKEND_URL = 'https://gtnhplanner.com'
npm run dev
```

`GTNH_PLANNER_URL` belongs to the **MCP process**, defaults to `http://localhost:3000`, and must match the exact browser origin for canvas pairing. It names the planner instance, not the dataset directory. Every data read uses HTTP:

```text
MCP -> configured planner /api/datasets/... -> local dataset files
                                        or -> configured remote dataset backend
```

The MCP never opens recipe files and never silently falls back to another source. A remote origin may be configured for query-only use; canvas edits require a local planner instance. The server can answer dataset queries without a paired browser.

## Configure clients

Use absolute paths. Build once after changes; the built server does not depend on the caller's working directory.

Codex `config.toml`:

```toml
[mcp_servers.gtnh]
command = "node"
args = ['E:\source\gtnh-factory-flow\dist-mcp\main.mjs']
env = { GTNH_PLANNER_URL = "http://localhost:3000" }
tool_timeout_sec = 90
```

Claude Code:

```sh
claude mcp add --transport stdio --env GTNH_PLANNER_URL=http://localhost:3000 gtnh -- node E:/source/gtnh-factory-flow/dist-mcp/main.mjs
```

Copy `skills/gtnh-production-planner` into the client's skill directory. For repo-scoped use this is `.agents/skills/gtnh-production-planner` for Codex and `.claude/skills/gtnh-production-planner` for Claude Code. Keep one maintained source; reinstall it after changes. Invoke `$gtnh-production-planner` in Codex or the corresponding skill in Claude Code. Configuration and skill installation are explicit setup steps; the repository does not overwrite user configuration automatically.

Ask the agent to call `begin_pairing`, open the exact returned planner address, then open **Settings > Agent** and paste the code. It expires after 10 minutes for the first connection. A browser tab is bound to that code; generating a new code replaces the connection. Keep the page open. Disconnect is visible in the same panel. Pairing credentials are not saved to disk or logged to stdout.

## Tool behaviour

- Data: `list_datasets`, `get_catalog`, `search_resources`, `search_recipes`, `get_recipes`.
- Connection: `get_status`, `begin_pairing`.
- Canvas: `list_designs`, `create_design`, `open_design`, `get_design`, `get_machine_options`, `apply_design_actions`, `evaluate_design`, `arrange_design`, `undo_design`, `redo_design`, `export_design`.

Searches default to 20 results and accept up to 120, returning total, offset and nextOffset. Search summaries and planning detail omit visual fields. Planning detail reports the presence of runtime calculation tables without returning the entire table. `get_recipes(detail: full)` preserves the complete schema-validated recipe body. Unknown gameplay metadata is retained. Read-only source APIs may filter virtual or iconless items; MCP does not claim to enumerate hidden exporter records.

Catalogs and design planning views are paginated too. `get_design(entityIds: [...])` narrows the returned cards, drawers and edges. Large full responses above the browser bridge's 3.9 MB response limit return an explicit size error; use planning pages instead.

All edits require the exact session, design, revision and dataset fingerprint; a changed browser or dataset must be reread. The webpage loads canonical complete recipe bodies through the same HTTP origin before adding them. The MCP's compact answers are never used as stored recipe bodies.

`apply_design_actions` accepts up to 200 actions and a unique requestId. Supported types are add_recipe, update_machine, replace_recipe, add_recipe_section, remove_recipe_section, select_input, add_drawer, set_drawer_rule, connect, disconnect, remove_entity and set_port_rate. Schema discovery supplies their exact inputs. Rates are per second; fluid amounts are litres. Call `get_design` for effective section and port indices. Drawers use resources already verified in the design's recipes. Batches stage all actions, validate them, then create one undo entry and one solve. An incompatible pre-existing wire must be explicitly disconnected in the same batch.

Saves use the existing IndexedDB concurrency guard even while the page is unfocused. A conflicting tab creates a conflict copy; the response identifies its new design ID. A save failure can leave a valid edited canvas with `persisted: false`; do not claim durable success. The page's save error must be resolved before further edits. Local undo/redo remains available; cloud/live and construction-locked designs are not editable by this bridge.

`evaluate_design` waits for non-stale books, checks all declared constraints, and reports `complete`. A feasible solver answer can still be incomplete because of unintended imports, output spills, missing anchors or machine gates. Theoretical counts and construction ceilings are reported separately. Generators are not automatically planned; electricity is external by default. Kept tools and initial charges still require the agent to disclose setup prerequisites.

The bridge binds 127.0.0.1 on an ephemeral port, checks the exact browser Origin and Host, and requires a random pairing credential. The browser rejects non-loopback pages and mismatched API origins. Commands run serially. Recent request IDs prevent duplicate execution in the same page session. After a timeout, page reload or dropped connection, read current state before attempting another mutation; no automatic write replay occurs.

Arrange reads the board's published geometry and uses the existing background worker. It refuses to guess card dimensions if the board is not ready. Existing boards with groups or annotations must use the webpage arrange control. Export returns JSON, plan code and link; opening them follows the existing new-design import rule.

## Validation

```sh
npm run typecheck
npm run test
npm run build:mcp
npm run build
npm run test:icons:browsers
npm run test:agent:browser
```

The browser test starts the built Next.js app and fronts it with a deterministic HTTP dataset fixture, then uses the official MCP client over stdio and pairs through the actual settings UI in a headless browser. The fixture recipes are artificial and verify protocol, conservation, persistence and rollback behaviour; they are not evidence that a particular GTNH recipe is correct. Live API smoke testing is separate and read-only. No deployment is part of this integration.

For an actual LLM planning pass using an already authenticated Claude Code installation, set `AGENT_TEST_LLM=claude` before the browser test. It supplies the skill and a complete target, relays the discovered MCP tools to the already-paired test page, and independently verifies the resulting new design. This optional test uses the client's configured model and account; ordinary browser tests do not invoke a model. Reports and temporary captures go under `scratch/agent-browser/`.
