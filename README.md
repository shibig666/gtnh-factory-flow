# GTNH Factory Flow

A production-chain planner for GregTech: New Horizons, live at
[gtnhplanner.com](https://gtnhplanner.com).

Search the real GTNH recipe set, place recipes as machine cards on a board, wire outputs
to inputs, and the solver works out rates, machine counts, power, bottlenecks and
surplus for the whole plan. Three modes hand the planner more of the work: **Build** (you
set machines and counts), **Solve** (you set target rates, it counts machines) and
**Pool** (it wires and imports too). Plans save in the browser, share as links, and can
be posted to the community hub.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck
npm run test
```

The app needs a recipe dataset. Either proxy the live one:

```bash
GTNH_DATASET_BACKEND_URL=https://gtnhplanner.com npm run dev
```

or place a dataset and its `datasets.manifest.json` under `public/datasets/gtnh/`
(ignored by git). Community features
need Supabase; see [docs/COMMUNITY.md](docs/COMMUNITY.md).

For a built LAN server on Linux or Windows, run `npm run build:production`, then
`npm run serve -- --host 0.0.0.0 --protocol http --port 8080`.
The server includes the agent relay on the same port and can generate a self-signed
HTTPS certificate. See the [production scripts and troubleshooting guide](docs/production-server.md).

## How it fits together

- `tools/dataset-pipeline/`: a Forge mod runs inside a real GTNH client and exports every
  recipe, NEI layout, machine and rendered icon; Node scripts normalize it into the
  dataset the app reads. Recipe data never comes from wikis or hand-written tables.
- `src/lib/`: the domain model, machine math (overclocks, parallels, curated per-machine
  behaviour checked against the mod source) and an LP-based solver.
- `src/components/`, `src/store/`: the Next.js + React Flow UI and Zustand stores.

Working notes for contributors and AI agents are in [AGENTS.md](AGENTS.md) and the
`CLAUDE.md` file in each area's folder.

## Agent integration

The MCP server lets Codex and Claude Code query recipes through the planner's HTTP
API and build or modify a paired browser design, locally or on a deployed HTTP(S) site. A companion skill guides target-driven
planning and checks the actual solver result. See [setup and validation](docs/agent-integration.md).

DeepSeek Harness users can install [a native DSH plugin](plugins/dsh-gtnh-planner/README.md).
It registers planning tools and guidance through the DSH SDK, without MCP or skill installation.
DSH 0.2.1-rc.2 and newer 0.2.x can arrange a finished flowchart and show its complete PNG
in the current chat. Both adapters expose `arrange_design` and `export_design_image`.
Both integrations share the same tools and connection modes. The [public relay deployment guide](docs/agent-relay.md)
explains design pairing over outbound WSS with no extra client port, including symmetric NAT.

## License and credits

Code is MIT licensed. GTNH, Minecraft, mod assets, generated datasets and icons are not
included and remain under their owners' licenses.

This project started as a fork of
[Samiracle64/gtnh-factory-flow](https://github.com/Samiracle64/gtnh-factory-flow) and has
since diverged into an independent codebase. The original work is MIT licensed and its
copyright is retained in `LICENSE`.
