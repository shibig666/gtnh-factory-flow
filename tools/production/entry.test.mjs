import { mkdir, mkdtemp, rm, rmdir, symlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("runs the bundled CLI through a directory link and reports invalid options", async () => {
  const scratch = path.resolve("scratch");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "production-entry-"));
  const actual = path.join(directory, "actual");
  const alias = path.join(directory, "linked");
  await mkdir(actual);
  let linked = false;
  try {
    await build({
      entryPoints: ["tools/production/server.mjs"],
      outfile: path.join(actual, "server.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "silent",
    });
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    for (const entry of [actual, alias]) {
      const result = spawnSync(process.execPath, [path.join(entry, "server.mjs"), "--help"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("GTNH production server");
    }
    const invalid = spawnSync(
      process.execPath,
      [
        path.join(alias, "server.mjs"),
        "--host",
        "127.0.0.1",
        "--protocol",
        "invalid",
        "--port",
        "8080",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("协议必须为 http 或 https");
  } finally {
    // Remove the link itself before cleaning the owned directory; never traverse a junction.
    if (linked) {
      if (process.platform === "win32") await rmdir(alias);
      else await rm(alias);
    }
    if (path.dirname(directory) !== scratch) throw new Error("Unexpected scratch directory");
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
