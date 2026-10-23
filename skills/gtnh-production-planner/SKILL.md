---
name: gtnh-production-planner
description: Use the GTNH Factory Flow MCP to find GTNH items and recipes, build or modify a production chain on a connected planner canvas, and verify target rates, machine tiers, external supplies and byproducts. Use for GTNH 产线规划、配方查询、机器配平和产线修改. Requires the gtnh-factory-flow MCP; does not control a running Minecraft world.
---

Use the configured planner's HTTP API as the recipe authority. Its server chooses local datasets or its remote dataset backend. Never read dataset files yourself, invent recipe IDs, edit recipe bodies or scrape the rendered recipe UI.

Pair only the configured planner origin. Remote HTTPS uses its outbound website relay and requires no client listening port. Keep the webpage open. In relay mode only granted designs are accessible; create designs only when grant.allowCreate permits it. Switching to an ungranted design revokes pairing. Legacy local pairing authorizes the browser session, including new designs. Cloud/live designs are unsupported. Reconnect never replays writes: after OUTCOME_UNKNOWN read the actual design before another edit.

## Establish the task

- Obtain target resources and rates, maximum technology tier, and allowed external inputs. Ask when these material constraints are missing. Clarify ambiguous item names using search results; Chinese instructions may need English dataset search terms.
- Use items/s and L/s for all tool arguments. Convert minutes and hours before writing. Power budgets are EU/t. Kept inputs are setup requirements, not consumption rates.
- Default to external electricity and report required voltage and EU/t. Expand generators and fuels only when requested. Do not claim a globally optimal route.

## Connect and inspect

Check get_status for the effective planner URL. To change it, DSH users open Plugins > dsh-gtnh-planner > 服务器连接 and save the server address and connection mode; MCP users change GTNH_PLANNER_URL and GTNH_AGENT_TRANSPORT and restart the MCP. Settings changes close the old connection and require pairing again. Inspect interrupted edits before retrying. Available GTNH versions come from the configured server's dataset manifest, not the plugin version. Use an advertised dataset ID and its fingerprint.

1. Call `get_status`. For queries alone no browser is needed. If canvas edits are requested and no browser is connected, call `begin_pairing` and show the returned code and planner URL. The user pastes it into Settings > Agent once; do not seek approval for every edit.
2. Copy the connected browser's `sessionId`, `revision` and `dataset` exactly. A fingerprint identifies the dataset for this task. Pass `versionId` explicitly to all following recipe queries.
3. Use `list_designs` and `open_design` for authorized existing designs. Create a new named design when requested and the connection allows it; otherwise edit the paired design. If a relay grant lacks new-design permission, ask the user to pair again with “Allow new designs in this session” enabled. Creation never replaces an existing design. Read `get_design` before edits.

## Build and improve the chain

- Search resources, then recipes across all maps. Search defaults to 20 results; follow `nextOffset` when relevant routes are missing. Read `get_recipes` with `detail: planning` for selected candidates, and `get_machine_options` for effective machine controls and gates. `full` is available for exceptional runtime data or debugging.
- Treat the website's IDs, alternatives, probabilities, kept-input markers, machine limits and metadata as authoritative. Do not approximate multiblock behaviour or cell/fluid conversion ratios.
- Recursively expand consumed inputs until they reach allowed external supplies. Track visited resources and recipes; recycling loops need an explicit entry supply and balanced outputs. Reuse compatible upstream producers and shared intermediates where sensible.
- Use `apply_design_actions` with a unique `requestId` and the current revision. Local `ref` names can address entities created earlier in the same batch. Add relevant recipes before drawers; the latter resolve resources from canonical recipe slots. New recipes are fetched independently by the browser, so no model-authored recipe JSON enters the design.
- `get_design` reports effective `section` and numbered `port` references. A shared card's sections start at 0. Kept inputs cannot be wired as consumed inputs. Change concrete alternatives with `select_input`. Use real Tank/Canner recipes to cross item/fluid forms.
- Set output demand with product drawers and an explicit rule, usually `exact` or `at-least`. Add source drawers for external supplies, and byproduct or trash drawers for unused products. A rule other than `ignore` needs a rate. Machine pins are optional; `solvePin: null` removes a pin. Changing a recipe or chosen input must also disconnect any incompatible wires in that batch.
- A successful edit returns fresh status and `refs`. Carry its revision forward. `persisted: false`, a save error or a conflict copy requires attention before claiming completion. Preserve unrelated manual edits.

## Verify and deliver

After completing edits, call arrange_design, carry forward its returned revision, then call export_design_image to show the entire flowchart in the current chat. The image tool returns native image content, not base64 text to paste. DSH shows an inline gallery and an Open full PNG action; MCP clients receive a standard PNG image block. Image export is read-only and does not replace solver verification. If the design changes during capture, reread and export again.

- Call `evaluate_design` with the full task constraints: targets, maximum tier, allowed inputs and optional supply caps, allowed outputs, and optional power budget. The tool waits for the requested revision's actual solver result. Never interpret tool transport success or solver feasibility alone as a completed chain.
- Inspect unmet targets, forbidden terminal or forced imports, forced outputs, buffer accumulation, unanchored parts, machine gates and loop notes. Repair the graph and evaluate again. Do not hide an intermediate deficit by expanding the allowed-input list without the user's instruction.
- Report setup tools, catalysts and initial charges separately. Probabilistic rates are expected values, not guaranteed tick output. Theoretical machine counts and their ceilings are different figures; a ceiling is a construction reference, not a proof of a globally optimized integer factory.
- On `REVISION_CONFLICT`, `DESIGN_CHANGED`, `SESSION_CHANGED` or `DATASET_CHANGED`, reread the current state and reconcile. Do not blindly retry. After `OUTCOME_UNKNOWN`, inspect the current design first: the previous operation may already have applied. Reusing a request ID is only valid for the exact same command in the same browser session.
- Stop with a concrete incomplete report if no eligible recipe exists, data is missing, a loop cannot be resolved, the solver fails or progress stalls. Keep useful partial work and identify the remaining decision.
- When complete, arrange the board, evaluate again and call `export_design_image` to show the complete PNG in this chat. Export plan JSON/codes if requested. Grouped or annotated designs use the webpage's arrange control. Summarize achieved rates, machine counts, external materials, electricity, byproducts and remaining assumptions in the user's language.

The source repository's `docs/agent-integration.md` describes installation and reproducible acceptance checks. It is not required during ordinary planning.
