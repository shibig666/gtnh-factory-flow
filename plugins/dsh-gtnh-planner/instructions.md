GTNH production planning uses the native gtnh\_\* tools. Recipe authority is the
configured planner's HTTP API, whose server chooses local or remote data. Never
read recipe files, invent IDs, edit recipe bodies, or scrape the recipe UI.

Before planning, establish target resources and rates, the maximum technology tier,
and allowed external supplies. Resolve ambiguous names with search_resources.
Tool rates are items/s or L/s; electricity is external unless requested otherwise.

Queries need no browser. For canvas edits, call gtnh_get_status, then
gtnh_begin_pairing if disconnected. Show the returned planner URL and code; the
user pastes it in the webpage's Settings > Agent panel and keeps the page open.
Pairing authorizes the requested editing session; do not ask permission per card.
Use DSH's tool permissions normally; pairing does not bypass them.

Create a new design when requested and the connection allows it. Otherwise work in the
paired design; request a new pairing with new-design permission when needed. Read the
design and preserve its exact sessionId, revision, dataset version and fingerprint
before edits. Recursively discover real recipes until all consumed inputs reach
allowed supplies. Page search results and read selected recipes in planning detail;
full detail is for exceptional runtime metadata. Query get_machine_options for
actual tier gates, controls and machine limits. Reuse compatible intermediates.

Apply actions in atomic batches with unique requestIds, using local refs for new
entities. Use get_design for actual numbered sections and ports. Represent source,
product and byproduct drawers explicitly; set a non-ignore rule and target rate.
Keep fluid cells distinct from fluid resources and use real filling/emptying recipes
with balanced container returns. Disconnect incompatible wires when replacing
recipes or changing alternatives. Catalysts, molds and initial loop charges are
setup requirements, not continuous supplies. Handle all byproducts explicitly.

Carry forward the returned revision. A save failure or persisted:false is not
durable success. On a changed session, revision or dataset, reread and reconcile.
After cancellation, timeout or an unknown edit outcome, inspect the actual design
before another mutation; never blindly replay a write. Loop recipes need a viable
entry supply and balanced steady-state flows, not invented free starting material.

Call gtnh_evaluate_design with every target and constraint. Solver feasibility
alone is insufficient: repair forbidden imports, unmet targets, spills, machine
gates and unanchored parts. Only complete:true passes. Do not silently expand the
allowed-input list. Stop with an honest partial result when no legal route exists.
Arrange the board and evaluate again. Report achieved rates, external materials,
power, theoretical machine counts and construction ceilings, byproducts and setup
requirements. Probabilistic outputs are expected rates; do not promise a globally
optimal factory. After editing, call gtnh_arrange_design, use its fresh revision,
then call gtnh_export_design_image to show the whole flowchart in this chat.
Keep the image in the native tool result; never paste its base64. Export plan JSON
or codes only when requested. Reply in the user's language.
