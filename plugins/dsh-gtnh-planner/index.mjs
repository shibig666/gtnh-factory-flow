import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import { createAgentConnection } from "@/lib/agent/create-connection";
import { CONNECTION_GUIDANCE, IMAGE_GUIDANCE } from "@/lib/agent/guidance";
import { PlannerApi } from "@/lib/agent/data-client";
import { createPlannerTools } from "@/lib/agent/tools";
import { errorResult } from "@/lib/agent/protocol";
import instructions from "./instructions.md";
import { isDesignImage, imageMetadata } from "@/lib/agent/image-protocol";

export const name = "gtnh-planner";
export const inject = ["tools", "systemPrompt", "attachments"];

export const Config = Schema.object({
  plannerUrl: Schema.string()
    .default("http://localhost:3000")
    .description("Planner address. Use the exact same origin in the browser."),
  connectionMode: Schema.union(["auto", "local", "relay"])
    .default("auto")
    .description("Auto: HTTP loopback uses a local bridge; HTTPS uses the website relay."),
});

export async function apply(ctx, config) {
  const api = new PlannerApi(config.plannerUrl);
  const bridge = createAgentConnection(api.baseUrl, config.connectionMode);
  const starting = bridge.start();
  ctx.effect(() => async () => {
    await starting.catch(() => undefined);
    await bridge.close();
  });
  await starting;

  for (const [index, tool] of createPlannerTools(api, bridge).entries()) {
    ctx.tools.register({
      name: `gtnh_${tool.name}`,
      description: tool.description,
      // Zod attaches non-JSON Standard Schema methods; DSH schemas must be plain JSON.
      parameters: JSON.parse(
        JSON.stringify(z.toJSONSchema(tool.schema, { target: "draft-7", io: "input" })),
      ),
      output: {
        schema: {},
        render: (_args, value) =>
          value?.kind === "gtnh-design-image"
            ? [
                { type: "text", text: JSON.stringify(value) },
                { type: "image", attachment: value.image },
                { type: "file", attachment: value.file },
              ]
            : [{ type: "text", text: JSON.stringify(value) }],
      },
      timeoutMs: 90_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        // Bind cancellation per call; sharing a mutable signal would cancel unrelated requests.
        const requestApi = new PlannerApi(api.baseUrl, (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([exec.signal, init.signal]) : exec.signal,
          }),
        );
        const requestBridge = {
          status: () => bridge.status(),
          beginPairing: () => bridge.beginPairing(),
          call: (method, params) => bridge.call(method, params, exec.signal),
        };
        try {
          const value = await createPlannerTools(requestApi, requestBridge)[index].run(args);
          exec.signal.throwIfAborted();
          if (value && typeof value === "object" && value.ok === false) {
            throw new Error(JSON.stringify(value));
          }
          if (isDesignImage(value)) {
            const data = Buffer.from(value.data, "base64");
            const image = await ctx.attachments.saveImage({
              data,
              mediaType: "image/png",
              name: value.name,
            });
            exec.signal.throwIfAborted();
            const file = await ctx.attachments.saveFile({ data, name: value.name });
            const filePath = ctx.attachments.fileHostPath(file);
            return { ...imageMetadata(value), image, file, ...(filePath ? { filePath } : {}) };
          }
          // DSH requires lossless JSON; omit undefined metadata just like the website API.
          return JSON.parse(JSON.stringify(value));
        } catch (error) {
          exec.signal.throwIfAborted();
          if (error instanceof Error && error.message.startsWith('{"ok":false')) throw error;
          throw new Error(JSON.stringify({ error: errorResult(error) }));
        }
      },
    });
  }
  ctx.systemPrompt.section({
    name: "gtnh-planner",
    order: 70,
    interpolate: false,
    text: `${CONNECTION_GUIDANCE}\n\n${IMAGE_GUIDANCE}\n\n${instructions}`,
  });
}
