// DSH loads browser plugins through its module registry, using the host's React and slots.
window.__ModuleLoader__.load({
  id: "dsh-gtnh-planner",
  factory: (require) => {
    const React = require("react");
    function ConnectionSettings({ form }) {
      const snapshot = React.useSyncExternalStore(
        React.useCallback((listener) => form.subscribe(listener), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      );
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const id = React.useId();
      const value = draft ?? snapshot.value ?? {};
      const editable = snapshot.status === "ready" && snapshot.writable && !saving;
      const fieldStyle = {
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 10px",
        border: "1px solid #777",
        borderRadius: 6,
        background: "transparent",
        color: "inherit",
        font: "inherit",
      };
      function edit(field, next) {
        setDraft((old) => ({
          ...(old ?? { ...snapshot.value, revision: snapshot.revision }),
          [field]: next,
        }));
        setMessage(null);
      }
      async function save(event) {
        event.preventDefault();
        if (!editable || !draft) return;
        let url;
        try {
          url = new URL(draft.plannerUrl.trim());
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          )
            throw Error();
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (draft.connectionMode === "local" && !loopback) throw Error();
        } catch {
          setMessage({
            error: true,
            text: "请输入完整的 HTTP 或 HTTPS 网站地址，不包含路径或账号。本地模式仅支持 localhost、127.0.0.1 或 [::1]。",
          });
          return;
        }
        setSaving(true);
        setMessage(null);
        try {
          const accepted = await form.mutate(
            [
              { op: "set", path: ["plannerUrl"], value: url.origin },
              { op: "set", path: ["connectionMode"], value: draft.connectionMode },
            ],
            draft.revision,
          );
          if (!accepted)
            throw Error("保存被拒绝，配置可能已被其他窗口修改。请点击重新读取后再试。");
          const active = form.getSnapshot().value;
          if (active?.plannerUrl !== url.origin || active?.connectionMode !== draft.connectionMode)
            throw Error("配置未生效，可能被其他配置覆盖。请重新读取并检查 DSH 配置。");
          setDraft(null);
          setMessage({
            text: "已保存。旧连接已关闭，请让 Agent 重新获取配对码，在新地址的网页中配对工程。",
          });
        } catch (error) {
          setMessage({
            error: true,
            text: error instanceof Error ? error.message : "保存失败，请重试。",
          });
        } finally {
          setSaving(false);
        }
      }
      let httpNotice = false;
      try {
        const address = new URL(value.plannerUrl);
        httpNotice =
          address.protocol === "http:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
      } catch {
        /* Incomplete addresses remain editable. */
      }
      return React.createElement(
        "form",
        {
          onSubmit: save,
          "aria-label": "GTNH 服务器连接",
          style: { display: "grid", gap: 12, maxWidth: 640, padding: "16px 0" },
        },
        React.createElement("h3", { style: { margin: 0 } }, "服务器连接"),
        React.createElement("label", { htmlFor: `${id}-url` }, "服务器地址"),
        React.createElement("input", {
          id: `${id}-url`,
          type: "url",
          required: true,
          placeholder: "https://planner.example.com",
          value: value.plannerUrl ?? "",
          disabled: !editable,
          style: fieldStyle,
          onChange: (event) => edit("plannerUrl", event.target.value),
        }),
        React.createElement(
          "p",
          { style: { margin: 0 } },
          "填写你部署的规划器网址，并在浏览器打开同一地址。例如 https://planner.example.com 或 http://localhost:3000。",
        ),
        React.createElement("label", { htmlFor: `${id}-mode` }, "连接模式"),
        React.createElement(
          "select",
          {
            id: `${id}-mode`,
            value: value.connectionMode ?? "auto",
            disabled: !editable,
            style: fieldStyle,
            onChange: (event) => edit("connectionMode", event.target.value),
          },
          React.createElement("option", { value: "auto" }, "自动（推荐）"),
          React.createElement("option", { value: "relay" }, "服务器中转（Relay）"),
          React.createElement("option", { value: "local" }, "本地连接（仅回环地址）"),
        ),
        React.createElement(
          "p",
          { style: { margin: 0 } },
          "自动模式：公网地址使用服务器中转，无需开放本机端口；本机 HTTP 使用本地连接。更改配置会关闭旧连接，需要重新配对。",
        ),
        httpNotice
          ? React.createElement(
              "p",
              { role: "alert" },
              "警告：HTTP 不加密配方、配对凭据和编辑数据，网络中的其他人可能读取或篡改。仍允许连接。",
            )
          : null,
        React.createElement(
          "p",
          { style: { margin: 0 } },
          "HTTPS 证书不受信任时仍允许连接，并在工具结果中显示身份未验证警告。该兼容仅适用于此服务器；浏览器需自行接受证书警告。",
        ),
        snapshot.status !== "ready"
          ? React.createElement(
              "p",
              { role: "status" },
              snapshot.status === "loading"
                ? "正在读取配置…"
                : "配置暂不可用，请启用插件并重启 DSH。",
            )
          : null,
        snapshot.status === "ready" && !snapshot.writable
          ? React.createElement("p", { role: "status" }, "当前 DSH 配置为只读，无法保存。")
          : null,
        React.createElement(
          "div",
          { style: { display: "flex", gap: 12 } },
          React.createElement(
            "button",
            { type: "submit", disabled: !editable || !draft },
            saving ? "正在保存…" : "保存连接设置",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              disabled: saving,
              onClick: () => {
                setDraft(null);
                setMessage(null);
              },
            },
            "重新读取",
          ),
        ),
        message
          ? React.createElement("p", { role: message.error ? "alert" : "status" }, message.text)
          : null,
      );
    }
    function ImageResult({ phase, block, renderFactorySlot, loadImage, openFile }) {
      if (phase !== "result") return React.createElement("p", null, "Exporting GTNH flowchart…");
      if (block.isError)
        return React.createElement(
          "p",
          { role: "alert" },
          block.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      const images = block.content
        .filter((part) => part.type === "image")
        .map((part) => ({ attachment: part.attachment }));
      let metadata;
      try {
        metadata = JSON.parse(block.content.find((part) => part.type === "text")?.text ?? "{}");
      } catch {
        metadata = {};
      }
      return React.createElement(
        "section",
        { "aria-label": "GTNH flowchart image", style: { padding: "12px 0" } },
        React.createElement(
          "p",
          null,
          `${metadata.name ?? "GTNH flowchart"} · ${metadata.width ?? "?"} × ${metadata.height ?? "?"}`,
        ),
        renderFactorySlot("conversation.images.content", { images, loadImage, align: "start" }),
        metadata.filePath
          ? React.createElement(
              "button",
              { type: "button", onClick: () => openFile(metadata.filePath) },
              "Open full PNG",
            )
          : null,
      );
    }
    return {
      inject: ["slots", "configForms"],
      apply(ctx) {
        const form = ctx.configForms.get("gtnh-planner");
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-gtnh-planner" }, () =>
            React.createElement(ConnectionSettings, { form }),
          ),
        );
        ctx.slots.inject("tool.call.toolview", () =>
          ctx.slots.register(
            {
              name: "tool.call.toolview",
              key: "gtnh_export_design_image",
            },
            ImageResult,
          ),
        );
      },
    };
  },
});
