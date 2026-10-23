import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const moduleRoot =
  process.env.GTNH_DSH_MODULE_ROOT ?? path.join(homedir(), ".dsh/profiles/node_modules");
const hostRequire = createRequire(path.join(moduleRoot, "gtnh-test.cjs"));
const loadHost = async (name) => import(pathToFileURL(hostRequire.resolve(name)).href);

export async function installTestPackage() {
  await mkdir(path.join(root, "scratch/dsh-tests"), { recursive: true });
  const installed = await mkdtemp(path.join(root, "scratch/dsh-tests/installation-"));
  const metadata = JSON.parse(
    await readFile(path.join(root, "plugins/dsh-gtnh-planner/package.json"), "utf8"),
  );
  execFileSync("tar", [
    "-xf",
    path.join(root, `dist-dsh/${metadata.name}-${metadata.version}.tgz`),
    "-C",
    installed,
  ]);
  const packageRoot = path.join(installed, "package");
  // The production profile loader resolves these peers from the host installation.
  // Exercise the unchanged tarball in isolation without touching user profiles or making junctions.
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier.startsWith("@deepseek-ai/") &&
        context.parentURL?.startsWith(pathToFileURL(packageRoot).href)
      ) {
        return next(pathToFileURL(hostRequire.resolve(specifier)).href, context);
      }
      return next(specifier, context);
    },
  });
  return { packageRoot, metadata, release: () => hook.deregister() };
}

export async function createDshClient(
  plannerUrl = "http://localhost:3000",
  connectionMode = "auto",
) {
  const installation = await installTestPackage();
  let ctx;
  try {
    const [{ Context }, prompt, tools, attachments, plugin] = await Promise.all([
      loadHost("@deepseek-ai/cordis"),
      loadHost("@deepseek-ai/dsh-system-prompt"),
      loadHost("@deepseek-ai/dsh-tools"),
      loadHost("@deepseek-ai/dsh-attachment-local"),
      import(pathToFileURL(path.join(installation.packageRoot, "lib/index.mjs")).href),
    ]);
    const runtime = JSON.parse(
      await readFile(hostRequire.resolve("@deepseek-ai/dsh/package.json"), "utf8"),
    );
    ctx = new Context();
    ctx.plugin(attachments.default, { dshHome: path.join(installation.packageRoot, "test-home") });
    ctx.plugin(prompt.default, {});
    ctx.plugin(tools.default, { mode: "native" });
    const fiber = ctx.plugin(plugin, { plannerUrl, connectionMode });
    await fiber;
    const deadline = Date.now() + 30_000;
    while (!ctx.tools?.get("gtnh_get_status")) {
      if (Date.now() > deadline)
        throw new Error(`DSH plugin did not expose its tools (fiber status ${fiber.status}).`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const guidance = (await ctx.systemPrompt.assemble()).sections.find(
      (section) => section.name === "gtnh-planner",
    );
    assert.ok(guidance.text.includes("gtnh_evaluate_design"));
    const client = {
      ctx,
      fiber,
      plugin,
      installation,
      runtimeVersion: runtime.version,
      guidance,
      listTools: async () => ({
        tools: ctx.tools.schemas().map((schema) => ({
          ...schema,
          name: schema.name.replace("gtnh_", ""),
        })),
      }),
      callTool: async ({ name, arguments: args = {} }) => {
        const result = await ctx.tools.execute({
          callId: randomUUID(),
          name: `gtnh_${name}`,
          arguments: args,
          signal: AbortSignal.timeout(90_000),
        });
        if (result.isError)
          return {
            isError: true,
            content: [{ type: "text", text: result.error.message }],
          };
        return { structuredContent: result.value, content: result.content };
      },
      close: async () => {
        await ctx.fiber.dispose();
        installation.release();
      },
    };
    return client;
  } catch (error) {
    await ctx?.fiber.dispose();
    installation.release();
    throw error;
  }
}
