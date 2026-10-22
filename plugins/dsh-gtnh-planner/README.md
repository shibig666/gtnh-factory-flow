# GTNH Planner: native DeepSeek Harness plugin

A Cordis/DSH SDK plugin for finding GTNH 2.9 recipes and creating, editing and
verifying production chains on a paired planner webpage. It registers 18 native
`gtnh_*` tools with `ctx.tools` and planning guidance with `ctx.systemPrompt`.
There is no MCP server, subprocess, skill provider or `SKILL.md` in this package.
It does not require a model key beyond the model already configured in DSH.

## Install

Build the distributable in this repository:

```powershell
npm run build:dsh
```

In the DSH **Plugins** page, install this package by absolute path:

```text
E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.1.0.tgz
```

The equivalent for the Web CLI is:

```powershell
dsh plugin --profile web add E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.1.0.tgz
```

Desktop users install through Desktop's Plugins page; the npm CLI cannot manage
the Desktop profile. Restart DSH if requested and start a new conversation. The
package is self-contained except for the DSH SDK packages provided by the host:
Cordis, Schemastery, Tools and System Prompt. The source checkout and its
node_modules are not needed after installation.

The declared target is DSH 0.2.x starting at 0.2.0-rc.2; test reports record the
exact runtime actually verified. Do not use a DSH compatibility exemption for a
runtime outside the declared range. Previously copied skills and MCP settings are
left untouched. Disable the old GTNH MCP configuration if you want only the native
tools; it is not needed by this plugin.

## Use

Start the local **planner webpage** separately, at `http://localhost:3000` by
default. To use the online dataset backend, from the planner repository:

```powershell
$env:GTNH_DATASET_BACKEND_URL = 'https://gtnhplanner.com'
npm run dev
```

Ask DSH:

> 使用 GTNH 原生工具，调用 gtnh_get_status 和 gtnh_list_datasets。
> 然后调用 gtnh_begin_pairing，告诉我网页地址和配对码。

Open that exact planner URL, paste the code in **Settings > Agent**, and keep the
page open. Then send a concrete target:

> 新建设计“青铜测试”。最高 LV，每分钟生产 8 个 Bronze Ingot。
> 只允许 Copper Dust、Tin Dust 和电力外供，通过搅拌机制作合金粉再加工成锭。
> 实际搭建、配平并排列产线，使用 gtnh_evaluate_design 验证。

Querying recipes does not need a paired browser. Canvas edits do. The plugin never
downloads a dataset or launches the planner webpage. The planner server remains
responsible for choosing local recipe files or its remote dataset backend.

## Configuration

The default planner address requires no configuration. An advanced installation
can override the bundle's existing row in its profile patch:

```yaml
- id: gtnh-planner
  config:
    plannerUrl: http://localhost:3001
```

Use an HTTP(S) origin without a path or credentials and open the exact same address
in the browser. Local loopback planner pages support editing; remote origins support
queries. HTTP errors never silently switch data sources.

## Lifecycle and constraints

All operations use DSH's native tool execution, guards, cancellation, recording and
result rendering. Planning guidance joins the existing system prompt without
replacing its persona. Pairing does not override the DSH permission policy.
Edits still enforce session, revision, dataset identity, atomic validation and
guarded persistence. Cancellation of a sent edit does not prove that it was rolled
back: inspect the design before another mutation.

Disabling or removing the bundle unregisters the tools and guidance and closes
its loopback WebSocket bridge. Saved designs are preserved. Re-enabling or
restarting creates a fresh connection and requires pairing again.

## Verification

```powershell
npm run build:dsh
$env:GTNH_DSH_MODULE_ROOT = 'C:/Users/shi/.dsh/profiles/node_modules'
npm run test:dsh
npm run test:dsh:install
npm run build
npm run test:dsh:browser
```

Tests extract the actual tarball to an isolated scratch directory and use the
host's real Cordis, Tools and System Prompt services, without loading an MCP or
skill service. They check API reads, native tool schemas, guards, cancellation,
unload and re-enable. Browser acceptance exercises pairing, real canvas editing,
solver evaluation, atomic rejection, undo/redo and persistence through native DSH
tool dispatch. Recipes in these tests are artificial; no LLM is invoked. Reports
are `scratch/dsh-tests/report.json` and `scratch/dsh-browser/report.json`.

The standalone MCP and skill elsewhere in the source repository remain available
for other clients. Both adapters reuse the same transport-neutral planner actions,
schemas and browser bridge, so recipe and editing behavior stays consistent.
