# 局域网生产运行

这套脚本运行已构建的 Next.js 网页及 Agent relay，供局域网浏览器、DSH 插件和通用 MCP 使用。
网页、配对 HTTP 和 WS/WSS 共用一个对外端口。内部 relay 自动选择回环端口，不需要额外配置或放行。
不使用 `next dev`，不需要 Caddy、Nginx 或 OpenSSL。现有 `npm start` 和独立 relay 的部署方式仍可使用。

## 首次准备

安装 Node.js 20.19 或更新版本（推荐与 CI 相同的 Node.js 24），进入项目目录：

```sh
npm ci
```

选择配方来源。若没有本地数据集，在项目根目录创建 `.env.production.local`：

```dotenv
GTNH_DATASET_BACKEND_URL=https://gtnhplanner.com
```

使用本地配方时，不设置该变量，将规范化的数据集及 `datasets.manifest.json` 放在
`public/datasets/gtnh/`。这是配方文件，与保存用户工程的数据库不同。
账号、社区和云端保存继续使用项目原有的 Supabase 配置；不配置时可以使用浏览器本地工程和 Agent。
这套启动器不启动 Live 多人协作服务，也不启动开发用的 PGlite 数据库。

然后构建：

```sh
npm run build:production
```

配方代理规则在构建时写入。更换 `GTNH_DATASET_BACKEND_URL` 后需要重新构建再启动，
启动器发现运行配置与构建不一致时会明确报错。
Next.js 构建会下载所使用的字体，首次构建需能访问字体源。

## Linux

交互启动，按提示输入监听地址、协议和端口：

```sh
sh tools/production/start.sh
```

不交互启动：

```sh
sh tools/production/start.sh --host 0.0.0.0 --protocol http --port 8080
sh tools/production/start.sh --host 0.0.0.0 --protocol https --port 8443 --public-host 192.168.1.10
```

## Windows

在 PowerShell 中交互启动：

```powershell
& .\tools\production\start.ps1
```

或指定参数：

```powershell
& .\tools\production\start.ps1 --host 0.0.0.0 --protocol http --port 8080
& .\tools\production\start.ps1 --host 0.0.0.0 --protocol https --port 8443 --public-host 192.168.1.10
```

如果 PowerShell 阻止脚本执行，可只对这次启动指定策略：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\production\start.ps1 --host 0.0.0.0 --protocol http --port 8080
```

两种系统也都可以直接运行：

```sh
npm run serve -- --host 0.0.0.0 --protocol http --port 8080
```

终端显示“已就绪”后才开始访问。脚本在前台运行，Ctrl+C 关闭网页与 relay。
升级代码后重新运行 `npm ci`、`npm run build:production`，停止旧进程，再启动新进程。
需要常驻时，可将同一条带完整参数的命令配置到 systemd 或 Windows 任务计划程序；
非交互运行必须提供 `--host`、`--protocol`、`--port`，不能等待终端输入。

## 地址与证书

- `--host` 是监听 IP，例如 `0.0.0.0`、某个具体局域网 IP、`127.0.0.1` 或 `::`。
- `--protocol` 为 `http` 或 `https`；`--port` 为 1–65535。
- `--public-host` 是用户访问的 IP 或域名，不带协议、路径或端口。
  监听 `0.0.0.0` / `::` 时默认选第一个非回环 IPv4；多个网卡、VPN 或虚拟网卡环境应显式指定。
  只监听 `127.0.0.1` 的服务无法让其他电脑访问。
- `--state-dir` 指定证书目录，默认为项目的 `.runtime/production/`。
  HTTPS 首次自动生成包含访问 IP / 域名的自签名证书，再次启动会重用；证书过期或损坏会重新生成。
  同一台服务器同时只运行一个使用该目录和访问地址的 HTTPS 实例。

例如服务显示 `http://192.168.1.10:8080`，其他电脑的浏览器和插件都填写这个地址。
**不要填写 `http://0.0.0.0:8080`，也不要在其他电脑填写 `localhost`。**
通过其他主机名访问网页时，启动器会跳转到显示的访问地址，让配对使用相同的 origin。
MCP/DSH 不跟随连接重定向，因此它们必须直接配置启动器显示的地址。

HTTPS 首次在浏览器中打开会出现证书警告，手动继续访问后再进行配对。
当前 DSH v0.4.0 和 MCP 支持不受信任的服务器证书，会给出警告。
HTTP 下网页不依赖 `crypto.randomUUID` 或 `crypto.subtle`，文本复制使用兼容回退；
浏览器图片剪贴板等能力可能仍受限制，可以使用文件导出或 Agent 聊天附件。

## 接入 Agent

DSH v0.4.0：在插件的服务器设置中填入显示的地址，连接模式选择“自动”或“服务器中转”。
使用回环 HTTP 地址时，“自动”仍采用原有本地桥接；想测试这套 relay 时显式选择“服务器中转”。
MCP 对应 `GTNH_PLANNER_URL` 和 `GTNH_AGENT_TRANSPORT=relay`。
客户端使用现有插件/MCP，无需为这套启动器安装另一个插件。

让 Agent 调用 `begin_pairing`，在同一地址网页的 Settings > Agent 批准工程。
需要 AI 新建工程时勾选允许新建，编辑时保持网页打开。
具体工具与权限见 [Agent 接入](agent-integration.md) 和 [relay 指南](agent-relay.md)。

## 排查客户端错误

如果执行启动脚本后立即返回、没有任何输出，请先更新并重建运行器：

```sh
git pull --ff-only
npm run build:server
sh tools/production/start.sh --help
```

应当显示帮助。目录链接、挂载目录的逻辑路径可能与 Node 加载模块的真实路径不同，
启动器不能用这两个路径的字符串相等判断是否运行入口。此情况只需重建运行器，无需重新构建网页。

| 现象                                                      | 检查与处理                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.randomUUID is not a function`、模块加载失败或白屏 | 完整更新代码并重新构建、重启旧服务，在浏览器按 Ctrl+Shift+R。HTTP 会缺少此原生 API，当前代码使用 `getRandomValues` 回退；无需修改浏览器安全标志。 |
| 配方不显示、manifest 404/500                              | 检查本地数据集或构建时的 `GTNH_DATASET_BACKEND_URL`；远程后端也必须能从服务器访问。更改来源后重新构建。                                           |
| `ERR_CONNECTION_REFUSED`、访问超时                        | 核对终端是否“已就绪”、监听 IP 与端口、服务器实际 IP。系统防火墙需允许所选端口的局域网访问。                                                       |
| 端口被占用 / `EADDRINUSE`                                 | 关闭旧实例或更换 `--port`。同一个端口只能运行一个 HTTP 或 HTTPS 服务。                                                                            |
| TLS 协议错误                                              | 访问协议要与 `--protocol` 一致。HTTPS 端口不能用 `http://` 打开，反之亦然。                                                                       |
| 自签名证书被浏览器拦截                                    | 先在该浏览器打开显示的 HTTPS 地址并接受警告，再配对；插件的兼容设置不能代替浏览器操作。                                                           |
| `ORIGIN_MISMATCH`、配对失败、重定向被拒绝                 | DSH/MCP 和浏览器都使用终端显示的完整地址，协议、主机和端口一致。不要把监听地址当作访问地址。                                                      |
| `RELAY_UNAVAILABLE` 或 WebSocket 404                      | 使用这套启动器，而不是单独的 `next start`。单独运行网页不会自动启动或转发 relay。                                                                 |
| 页面刷新、服务重启后 Agent 断开                           | 重新发起配对；工程仍保存在原浏览器，配对凭据在内存中。检查工程现状后再继续修改。                                                                  |

打开 `http(s)://访问地址:端口/_server/health` 可查看运行的 `origin`、`buildId` 和 relay 状态，
用于确认连接到新服务，而不是另一个端口上的旧进程。

## 验收

```sh
npm run typecheck
npm test
npm run build:production
npm run test:production:browser
```

生产浏览器验收在非回环网卡上分别启动 HTTP 与自签名 HTTPS，加载真实 Next.js 网页，
经过真实配对 API 和 WS/WSS，再刷新页面检查模块错误。配方使用浏览器夹具，
不证明服务器上已安装真实 GTNH 数据集。Windows 可设置 `GTNH_TEST_WINDOWS_WRAPPER=1`
让验收使用 PowerShell 包装脚本。报告位于 `scratch/production-browser/`。
