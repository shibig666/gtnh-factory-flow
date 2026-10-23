import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import { createAgentConnection } from "@/lib/agent/create-connection";
import { connectionMode } from "@/lib/agent/connection";
import {
  CONNECTION_GUIDANCE,
  IMAGE_GUIDANCE,
  SERVER_SETTINGS_GUIDANCE,
} from "@/lib/agent/guidance";
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
    .description("Planner address. Use the exact same origin in the browser.")
    .volatile(),
  connectionMode: Schema.union(["auto", "local", "relay"])
    .default("auto")
    .description("Auto: HTTP loopback uses a local bridge; HTTPS uses the website relay.")
    .volatile(),
});

export async function apply(ctx, config) {
  function readConfig(value = config) {
    const api = new PlannerApi(value.plannerUrl.get());
    const mode = value.connectionMode.get();
    const transport = connectionMode(api.baseUrl, mode);
    if (
      transport === "relay" &&
      new URL(api.baseUrl).protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(api.baseUrl).hostname)
    ) {
      throw new Error("Remote agent connections require HTTPS.");
    }
    return { api, mode, key: `${api.baseUrl}|${mode}` };
  }
  // Validate before the host persists a settings edit, including combinations of fields.
  ctx.on("internal/config", (_raw, next) => {
    const raw = next();
    readConfig(Config(raw));
    return raw;
  });
  let current;
  let disposed = false;
  function connection() {
    if (disposed) throw new Error("The GTNH plugin has been disabled.");
    const next = readConfig();
    if (current?.key === next.key) return current;
    const previous = current;
    const session = {
      ...next,
      bridge: createAgentConnection(next.api.baseUrl, next.mode),
      controller: new AbortController(),
    };
    current = session;
    previous?.controller.abort(
      new Error("Planner settings changed. Inspect the design before retrying any edit."),
    );
    session.ready = (async () => {
      if (previous) {
        await previous.ready.catch(() => undefined);
        await previous.bridge.close();
      }
      await session.bridge.start();
    })();
    return session;
  }
  ctx.on("loader/volatile-update", () => {
    // Close the old grant immediately; operations are never replayed on the new site.
    void connection().ready.catch(() => undefined);
  });
  const initial = connection();
  ctx.effect(() => async () => {
    disposed = true;
    current.controller.abort();
    await current.ready.catch(() => undefined);
    await current.bridge.close();
  });
  await initial.ready;

  for (const [index, tool] of createPlannerTools(initial.api, initial.bridge).entries()) {
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
        const session = connection();
        await session.ready;
        const { api, bridge } = session;
        const signal = AbortSignal.any([exec.signal, session.controller.signal]);
        signal.throwIfAborted();
        // Bind cancellation per call; sharing a mutable signal would cancel unrelated requests.
        const requestApi = new PlannerApi(api.baseUrl, (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          }),
        );
        const requestBridge = {
          status: () => bridge.status(),
          beginPairing: () => bridge.beginPairing(),
          call: (method, params) => bridge.call(method, params, signal),
        };
        try {
          const value = await createPlannerTools(requestApi, requestBridge)[index].run(args);
          signal.throwIfAborted();
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
            signal.throwIfAborted();
            const file = await ctx.attachments.saveFile({ data, name: value.name });
            signal.throwIfAborted();
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
    text: `${CONNECTION_GUIDANCE}\n\n${SERVER_SETTINGS_GUIDANCE}\n\n${IMAGE_GUIDANCE}\n\n${instructions}`,
  });
}
