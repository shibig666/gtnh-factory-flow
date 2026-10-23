// DSH loads browser plugins through its module registry, using the host's React and slots.
window.__ModuleLoader__.load({
  id: "dsh-gtnh-planner",
  factory: (require) => {
    const React = require("react");
    function ImageResult({ phase, block, renderSlot, loadImage, openFile }) {
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
        renderSlot("tool.call.images", { images, loadImage, align: "start" }),
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
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("tool.call.toolview", () =>
          ctx.slots.register(
            {
              name: "tool.call.toolview",
              key: "gtnh_export_design_image",
              children: { "tool.call.images": { kind: "single", scope: "session" } },
            },
            ImageResult,
          ),
        );
      },
    };
  },
});
