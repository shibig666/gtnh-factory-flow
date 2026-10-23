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
E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.2.0.tgz
```

The equivalent for the Web CLI is:

```powershell
dsh plugin --profile web add E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.2.0.tgz
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

Use your deployed planner's HTTPS address, or start the local **planner webpage**
at `http://localhost:3000`. Local development can use the online dataset backend:

```powershell
$env:GTNH_DATASET_BACKEND_URL = 'https://gtnhplanner.com'
npm run dev
```

Ask DSH:

> 使用 GTNH 原生工具，调用 gtnh_get_status 和 gtnh_list_datasets。
> 然后调用 gtnh_begin_pairing，告诉我网页地址和配对码。

Open that exact planner URL, paste the code in **Settings > Agent**, and keep the
page open. For a new production design, enable **Allow new designs in this session**
before connecting. Default relay permission covers only the selected design. Then send a concrete target:

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
    plannerUrl: https://planner.example.com
    connectionMode: auto
```

Use an origin without a path or credentials and open that exact address in the
browser. Reload the plugin after changing configuration and pair again.
`auto` keeps HTTP loopback compatible with the local bridge; HTTPS uses the
website's outbound relay. `relay` forces relay mode for local development, and
`local` is restricted to loopback. Public sites require HTTPS and a configured
relay. Users need no listening port, including behind symmetric NAT.
HTTP errors never silently switch data sources. Server operators should follow
the [relay deployment guide](https://github.com/shibig666/gtnh-factory-flow/blob/main/docs/agent-relay.md).

## Lifecycle and constraints

All operations use DSH's native tool execution, guards, cancellation, recording and
result rendering. Planning guidance joins the existing system prompt without
replacing its persona. Pairing does not override the DSH permission policy.
Edits still enforce session, revision, dataset identity, atomic validation and
guarded persistence. Cancellation of a sent edit does not prove that it was rolled
back: inspect the design before another mutation.

Disabling or removing the bundle unregisters the tools and guidance and closes
its connection and revokes the relay grant. Saved designs are preserved. Re-enabling or
restarting creates a fresh connection and requires pairing again.

Relay grants expire after twelve hours and bind the browser session and selected
designs. Switching to an ungranted design revokes pairing. Short interruptions
reconnect without replaying writes; inspect the design after an unknown outcome.
The browser must stay open. Cloud/live designs and headless planning are not
supported by this bridge; an online website still saves these designs in browser IndexedDB.

## Verification

```powershell
npm run build:dsh
$env:GTNH_DSH_MODULE_ROOT = 'C:/Users/shi/.dsh/profiles/node_modules'
npm run test:dsh
npm run test:dsh:install
npm run build
npm run test:dsh:browser
npm run test:dsh:relay:browser
```

Tests extract the actual tarball to an isolated scratch directory and use the
host's real Cordis, Tools and System Prompt services, without loading an MCP or
skill service. They check API reads, native tool schemas, guards, cancellation,
unload and re-enable. Browser acceptance exercises pairing, real canvas editing,
solver evaluation, atomic rejection, undo/redo and persistence through native DSH
tool dispatch. Recipes in these tests are artificial; no LLM is invoked. Reports
are `scratch/dsh-tests/report.json`, `scratch/dsh-browser/report.json` and
`scratch/dsh-relay-browser/report.json`.

The standalone MCP and skill elsewhere in the source repository remain available
for other clients. Both adapters reuse the same transport-neutral planner actions,
schemas and browser bridge, so recipe and editing behavior stays consistent.
