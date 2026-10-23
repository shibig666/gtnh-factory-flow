# GTNH Factory Flow MCP

The MCP server exposes recipe discovery and a paired browser canvas, locally or on a deployed HTTP(S) site. The companion skill guides target-driven recipe selection, graph construction and solver validation. It does not run another LLM or need a separate model API key. For public hosting, follow the [relay deployment guide](agent-relay.md).

## Start

Use Node.js 20.19 or newer (CI uses 24). In the repository:

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

The MCP never opens recipe files and never silently falls back to another source. Remote HTTP(S) canvas editing uses the site's relay. Queries need no paired browser; edits require its webpage to stay open.

Available GTNH releases and datasets come from that server's manifest. Both MCP
and the native plugin use its advertised versions without a hardcoded 2.9 filter.
The server remains responsible for version support and compatible normalized data.

## Configure clients

DeepSeek Harness also has a [native SDK plugin](../plugins/dsh-gtnh-planner/README.md).
Install its single package through DSH's Plugins page, then fully restart the DSH
backend or Desktop to load the updated client module. It provides native planning
tools and system-prompt guidance. Its plugin detail page provides **服务器地址**,
**连接模式** and **保存连接设置**. Saved changes apply immediately and require
pairing with the new site's webpage. The equivalent MCP options remain
`GTNH_PLANNER_URL` and `GTNH_AGENT_TRANSPORT`; restart the MCP after changing them.
It does not use MCP or a filesystem skill provider;
the setup below is for clients using the standalone MCP interface.

Use absolute paths. Build once after changes; the built server does not depend on the caller's working directory.

Codex `config.toml`:

```toml
[mcp_servers.gtnh]
command = "node"
args = ['E:\source\gtnh-factory-flow\dist-mcp\main.mjs']
env = { GTNH_PLANNER_URL = "https://planner.example.com", GTNH_AGENT_TRANSPORT = "auto" }
tool_timeout_sec = 90
```

Claude Code:

```sh
claude mcp add --transport stdio --env GTNH_PLANNER_URL=http://localhost:3000 gtnh -- node E:/source/gtnh-factory-flow/dist-mcp/main.mjs
```

Copy `skills/gtnh-production-planner` into the client's skill directory. For repo-scoped use this is `.agents/skills/gtnh-production-planner` for Codex and `.claude/skills/gtnh-production-planner` for Claude Code. Keep one maintained source; reinstall it after changes. Invoke `$gtnh-production-planner` in Codex or the corresponding skill in Claude Code. Configuration and skill installation are explicit setup steps; the repository does not overwrite user configuration automatically.

Ask the agent to call `begin_pairing`, open the returned address, then paste the code in **Settings > Agent**. Relay codes expire in ten minutes and can be approved once. Default permission covers the selected design; enable **Allow new designs in this session** when needed. Grants last at most twelve hours. Keep the page open. Disconnect or switching to an ungranted design revokes access. Pairing credentials stay in memory and are not logged.

`GTNH_AGENT_TRANSPORT=auto` uses the legacy local bridge for HTTP loopback and the website relay for other HTTP(S) origins. `relay` forces the relay for local testing; `local` requires loopback. Both browser and MCP make outbound WS(S) connections to the website without opening a local port. Missing relay configuration is an explicit error.

Public HTTP is allowed with an unencrypted-traffic warning. HTTPS certificate
verification failures are also allowed with an identity warning: only requests
and WSS connections to the configured planner origin use this compatibility.
Global TLS checks remain enabled, redirects are refused and delivered writes are
never retried. `securityWarnings` appears in tool results and stderr. The browser
must separately accept the site's certificate warning. Pairing credentials and
edits may be exposed when using these connection modes.

## Tool behaviour

- Data: `list_datasets`, `get_catalog`, `search_resources`, `search_recipes`, `get_recipes`.
- Connection: `get_status`, `begin_pairing`.
- Canvas: `list_designs`, `create_design`, `open_design`, `get_design`, `get_machine_options`, `apply_design_actions`, `evaluate_design`, `arrange_design`, `undo_design`, `redo_design`, `export_design`, `export_design_image`.

Searches default to 20 results and accept up to 120, returning total, offset and nextOffset. Search summaries and planning detail omit visual fields. Planning detail reports the presence of runtime calculation tables without returning the entire table. `get_recipes(detail: full)` preserves the complete schema-validated recipe body. Unknown gameplay metadata is retained. Read-only source APIs may filter virtual or iconless items; MCP does not claim to enumerate hidden exporter records.

Catalogs and design planning views are paginated too. `get_design(entityIds: [...])` narrows the returned cards, drawers and edges. Large full responses above the browser bridge's 3.9 MB response limit return an explicit size error; use planning pages instead.

All edits require the exact session, design, revision and dataset fingerprint; a changed browser or dataset must be reread. The webpage loads canonical complete recipe bodies through the same HTTP origin before adding them. The MCP's compact answers are never used as stored recipe bodies.

`apply_design_actions` accepts up to 200 actions and a unique requestId. Supported types are add_recipe, update_machine, replace_recipe, add_recipe_section, remove_recipe_section, select_input, add_drawer, set_drawer_rule, connect, disconnect, remove_entity and set_port_rate. Schema discovery supplies their exact inputs. Rates are per second; fluid amounts are litres. Call `get_design` for effective section and port indices. Drawers use resources already verified in the design's recipes. Batches stage all actions, validate them, then create one undo entry and one solve. An incompatible pre-existing wire must be explicitly disconnected in the same batch.

Saves use the existing IndexedDB concurrency guard even while the page is unfocused. A conflicting tab creates a conflict copy; the response identifies its new design ID. A save failure can leave a valid edited canvas with `persisted: false`; do not claim durable success. The page's save error must be resolved before further edits. Local undo/redo remains available; cloud/live and construction-locked designs are not editable by this bridge.

`evaluate_design` waits for non-stale books, checks all declared constraints, and reports `complete`. A feasible solver answer can still be incomplete because of unintended imports, output spills, missing anchors or machine gates. Theoretical counts and construction ceilings are reported separately. Generators are not automatically planned; electricity is external by default. Kept tools and initial charges still require the agent to disclose setup prerequisites.

The legacy local bridge binds 127.0.0.1 on an ephemeral port and validates Origin, Host and a random credential. The remote relay uses separate agent/browser credentials, same-origin approval and design-scoped authorization. Commands run serially in the webpage. Recent request IDs prevent duplicate execution within bounded caches. After timeout or disconnect, inspect the current state before another mutation. Transient relay reconnections never replay writes. Page refresh or relay restart requires pairing again.

Arrange reads the board's published geometry and uses the existing background worker. It refuses to guess card dimensions if the board is not ready. Existing boards with groups or annotations must use the webpage arrange control. Export returns JSON, plan code and link; opening them follows the existing new-design import rule.

After editing, call `arrange_design`, copy the resulting revision and call
`export_design_image`. This read-only tool returns the entire flowchart as a
standard MCP PNG image block, with metadata in text and structured content.
It includes offscreen nodes and wires; it is not a screenshot of the current
viewport. MCP clients supporting image results can show it in the current chat.
Do not print raw base64. For DSH, the native plugin provides an official attachment
gallery plus an action to open the exact original PNG.

Image bytes travel through bounded browser chunks with SHA-256 verification,
without public URLs or extra ports. Temporary browser captures expire after five
minutes, are limited to two entries and are released after transfer. Images up to
16 MiB are supported. The existing renderer caps each pixel side at 8192 and can
scale larger boards to fit the full frame. A changed design revision aborts the
capture or transfer; reread the design before exporting again.

## Validation

```sh
npm run typecheck
npm run test
npm run build:mcp
npm run build
npm run test:icons:browsers
npm run test:agent:browser
npm run test:agent:relay:browser
```

The browser test starts the built Next.js app and fronts it with a deterministic HTTP dataset fixture, then uses the official MCP client over stdio and pairs through the actual settings UI in a headless browser. The fixture recipes are artificial and verify protocol, conservation, persistence and rollback behaviour; they are not evidence that a particular GTNH recipe is correct. Live API smoke testing is separate and read-only. No deployment is part of this integration.

For an actual LLM planning pass using an already authenticated Claude Code installation, set `AGENT_TEST_LLM=claude` before the browser test. It supplies the skill and a complete target, relays the discovered MCP tools to the already-paired test page, and independently verifies the resulting new design. This optional test uses the client's configured model and account; ordinary browser tests do not invoke a model. Reports and temporary captures go under `scratch/agent-browser/`.
