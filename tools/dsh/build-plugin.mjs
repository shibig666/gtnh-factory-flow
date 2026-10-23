import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(root, "plugins/dsh-gtnh-planner");
const output = path.join(root, "dist-dsh");
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "scratch/dsh-build"), { recursive: true });
const staging = await mkdtemp(path.join(root, "scratch/dsh-build/package-"));
await mkdir(path.join(staging, "lib"), { recursive: true });
await copyFile(path.join(source, "client.mjs"), path.join(staging, "lib/client.js"));

for (const file of ["package.json", "cordis.patch.yml", "README.md"]) {
  await copyFile(path.join(source, file), path.join(staging, file));
}
await copyFile(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["plugins/dsh-gtnh-planner/index.mjs"],
  outfile: path.join(staging, "lib/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@deepseek-ai/*", "bufferutil", "utf-8-validate"],
  loader: { ".md": "text" },
  banner: {
    js: 'import { createRequire as __gtnhCreateRequire } from "node:module"; const require = __gtnhCreateRequire(import.meta.url);',
  },
  metafile: true,
  legalComments: "eof",
  logLevel: "warning",
});
if (
  Object.keys(bundled.metafile.inputs).some((file) => /modelcontextprotocol|src\/mcp\//.test(file))
) {
  throw new Error("The native DSH plugin must not bundle an MCP runtime.");
}

// Bundled dependencies travel with their license text, including transitive packages.
const licenses = new Map();
for (const input of Object.keys(bundled.metafile.inputs).filter((file) =>
  file.includes("node_modules/"),
)) {
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) {
        const key = `${metadata.name}@${metadata.version}`;
        if (!licenses.has(key)) {
          const files = (await readdir(directory)).filter((file) =>
            /^(licen[cs]e|copying)(\.|$)/i.test(file),
          );
          if (!files.length) throw new Error(`Missing bundled license: ${key}`);
          licenses.set(
            key,
            (
              await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))
            ).join("\n"),
          );
        }
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
await writeFile(
  path.join(staging, "THIRD_PARTY_NOTICES.md"),
  "# Bundled dependency licenses\n\n" +
    [...licenses]
      .sort()
      .map(([name, license]) => `## ${name}\n\n${license.trim()}\n`)
      .join("\n"),
);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the builder with npm run build:dsh.");
const packed = JSON.parse(
  execFileSync(
    process.execPath,
    [npmCli, "pack", staging, "--pack-destination", output, "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: path.join(root, "scratch/npm-cache") },
    },
  ),
);
console.log(path.join(output, packed[0].filename));
