# GTNH Planner: native DeepSeek Harness plugin

A Cordis/DSH SDK plugin for finding GTNH recipes and creating, editing and
verifying production chains on a paired planner webpage. It registers 19 native
`gtnh_*` tools with `ctx.tools` and planning guidance with `ctx.systemPrompt`.
There is no MCP server, subprocess, skill provider or `SKILL.md` in this package.
It does not require a model key beyond the model already configured in DSH.
The connected planner's manifest determines available GTNH versions and datasets.
The plugin does not restrict them to a particular GTNH release; the server must
provide the planner API and normalized recipe schema expected by these tools.

## Install

Build the distributable in this repository:

```powershell
npm run build:dsh
```

In the DSH **Plugins** page, install this package by absolute path:

```text
E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.4.0.tgz
```

The equivalent for the Web CLI is:

```powershell
dsh plugin --profile web add E:/source/gtnh-factory-flow/dist-dsh/dsh-gtnh-planner-0.4.0.tgz
```

Desktop users install through Desktop's Plugins page; the npm CLI cannot manage
the Desktop profile. After updating, fully restart the DSH backend or Desktop,
reload the page and start a new conversation. Refreshing only the browser does
not rebuild the Host's client-module inventory. The
package is self-contained except for the DSH SDK packages provided by the host:
Cordis, Schemastery, Tools, System Prompt and Attachments. The source checkout and its
node_modules are not needed after installation.

The declared target is DSH 0.2.x starting at 0.2.1-rc.2, including Desktop; test reports record the
exact runtime actually verified. Do not use a DSH compatibility exemption for a
runtime outside the declared range. Previously copied skills and MCP settings are
left untouched. Disable the old GTNH MCP configuration if you want only the native
tools; it is not needed by this plugin.

## Use

Use your deployed planner's HTTP or HTTPS address, or start the local **planner webpage**
at `http://localhost:3000`. Local development can use the online dataset backend:

```powershell
$env:GTNH_DATASET_BACKEND_URL = 'https://gtnhplanner.com'
npm run dev
```

In **Plugins > dsh-gtnh-planner > 服务器连接**, enter the planner's address,
leave **连接模式** on **自动**, and click **保存连接设置**. Then ask DSH:

> 使用 GTNH 原生工具，调用 gtnh_get_status 和 gtnh_list_datasets。
> 然后调用 gtnh_begin_pairing，告诉我网页地址和配对码。

Open that exact planner URL, paste the code in **Settings > Agent**, and keep the
page open. For a new production design, enable **Allow new designs in this session**
before connecting. Default relay permission covers only the selected design. Then send a concrete target:

> 新建设计“青铜测试”。最高 LV，每分钟生产 8 个 Bronze Ingot。
> 只允许 Copper Dust、Tin Dust 和电力外供，通过搅拌机制作合金粉再加工成锭。
> 实际搭建、配平并排列产线，使用 gtnh_evaluate_design 验证。
> 完成后整理流程图，导出完整图片并显示在当前聊天中。

Querying recipes does not need a paired browser. Canvas edits do. The plugin never
downloads a dataset or launches the planner webpage. The planner server remains
responsible for choosing local recipe files or its remote dataset backend.

## Arrange and export to this chat

`gtnh_arrange_design` arranges the current ungrouped flowchart as one undoable edit.
Carry forward its returned revision, then call `gtnh_export_design_image` with the
same session, design and dataset. The tool exports the entire board, including
offscreen cards, wires and annotations, using the website's ordinary PNG exporter.
Grouped/annotated layout still uses the webpage's arrange control; image export
includes those designs without rearranging them.

The plugin saves a durable image preview through DSH Attachments. Its bundled
chat view shows the official image gallery directly under the tool result and
an **Open full PNG** button for the exact original file. DSH may normalize the
preview; the separately saved PNG preserves every original byte. No public upload,
clipboard permission or local browser download is required. The AI should not
paste base64 into its answer. The view requires the standard Desktop/Web Tool and
Attachment UI plugins, already included in those profiles.

PNG transfer uses bounded chunks and SHA-256 verification. Complete PNGs up to
16 MiB and 8192 pixels per side are supported; the existing board exporter may
scale large boards to its canvas limit while preserving the whole frame. Changes
during capture or transfer cause a revision error, rather than returning a stale image.

## Configuration

The plugin detail page includes **服务器地址**, **连接模式** and **保存连接设置**.
Settings persist in the active DSH profile and apply immediately without restarting
DSH. Changing either setting closes the previous connection, cancels outstanding
operations and requires pairing again. Inspect any interrupted edits before retrying.
The default address is `http://localhost:3000`.

Advanced installations can also override the bundle's existing row in the profile patch:

```yaml
- id: gtnh-planner
  config:
    plannerUrl: https://planner.example.com
    connectionMode: auto
```

Use an origin without a path or credentials and open that exact address in the
browser. After saving, call `gtnh_get_status` to check the effective address,
then `gtnh_begin_pairing` to pair with that site's webpage.
`auto` keeps HTTP loopback compatible with the local bridge; remote HTTP(S) uses the
website's outbound relay. `relay` forces relay mode for local development, and
`local` is restricted to loopback. Public sites need a configured relay. HTTP is
allowed with an unencrypted-traffic warning. Untrusted HTTPS certificates are also
allowed: the client first verifies the certificate, then uses compatibility only
for the configured origin if certificate verification fails. `securityWarnings`
appears in tool results and native logs. No global TLS setting is changed, and
credentials never follow redirects to another origin. The browser must accept its
own certificate warning before opening that website. Users need no listening port,
including behind symmetric NAT.
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
npm install --prefix scratch/dsh-sdk --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.2
$env:GTNH_DSH_MODULE_ROOT = (Resolve-Path 'scratch/dsh-sdk/node_modules').Path
npm run test:dsh
npm run test:dsh:install
npm run test:dsh:app
npm run build
npm run test:dsh:browser
npm run test:dsh:relay:browser
npm run test:dsh:client
```

Tests extract the actual tarball to an isolated scratch directory and use the
host's real Cordis, Tools, System Prompt and Attachment services, without loading an MCP or
skill service. They check API reads, native tool schemas, guards, cancellation,
unload and re-enable. The settings test uses the actual ConfigEditor, Settings
and Loader to verify persisted changes, live server switching, closure of the old
bridge, revision conflicts and refusal of invalid addresses before they reach disk.
Browser acceptance exercises pairing, real canvas editing,
solver evaluation, atomic rejection, undo/redo and persistence through native DSH
tool dispatch. Recipes in these tests are artificial; no LLM is invoked. Reports
are `scratch/dsh-tests/report.json`, `scratch/dsh-browser/report.json`,
`scratch/dsh-relay-browser/report.json` and `scratch/dsh-client/report.json`.
The client test mounts the packaged tool view with the target SDK's official
gallery in headless Chromium, and exercises the package-detail configuration form's
save and error handling against a form-contract fixture. It does not control the user's Desktop application.
The app test starts the complete DSH Web profile from the isolated installation,
opens the real Plugins detail page, saves a server address through the Host settings
API, reloads, verifies persistence and creates a real conversation to exercise
Agent presets. It also rejects browser initialization errors
such as duplicate SDK slot declarations. Its report is `scratch/dsh-app/report.json`.

The standalone MCP and skill elsewhere in the source repository remain available
for other clients. Both adapters reuse the same transport-neutral planner actions,
schemas and browser bridge, so recipe and editing behavior stays consistent.
