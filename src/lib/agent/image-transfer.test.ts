import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID, randomFillSync } from "node:crypto";
import { PNG } from "pngjs";
import { collectDesignImage } from "./image-transfer";
import { AGENT_IMAGE_CHUNK_BYTES } from "./image-protocol";
import { captureAgentImage, agentImageChunk, clearAgentImages } from "./browser-image";
import {
  FLOW_IMAGE_EXPORT_EVENT,
  FLOW_IMAGE_EXPORT_COMPLETE_EVENT,
} from "@/lib/import-export/plan-image";

afterEach(() => {
  clearAgentImages();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const png = PNG.sync.write(new PNG({ width: 20, height: 10 }));
const manifest = {
  artifactId: randomUUID(),
  mimeType: "image/png",
  name: "factory.png",
  width: 20,
  height: 10,
  bytes: png.length,
  sha256: createHash("sha256").update(png).digest("hex"),
};
const envelope = (value: unknown) => ({ ok: true, value });

it("collects bounded chunks, verifies PNG integrity and releases the browser capture", async () => {
  const call = vi.fn(async (method: string) =>
    method === "export_design_image"
      ? envelope(manifest)
      : method === "get_design_image_chunk"
        ? envelope({
            artifactId: manifest.artifactId,
            offset: 0,
            nextOffset: png.length,
            data: png.toString("base64"),
          })
        : envelope({ released: true }),
  );
  const image = await collectDesignImage({ call }, { designId: "allowed" });
  expect(image.kind).toBe("gtnh-design-image");
  expect(Buffer.from(image.data, "base64")).toEqual(png);
  expect(call.mock.calls.at(-1)?.[0]).toBe("release_design_image");
});

it("rejects corrupt or non-progressing chunks and releases them even on failure", async () => {
  for (const data of [
    { data: "", nextOffset: 0 },
    { data: Buffer.alloc(png.length).toString("base64"), nextOffset: png.length },
  ]) {
    const call = vi.fn(async (method: string) =>
      method === "export_design_image"
        ? envelope(manifest)
        : envelope({ artifactId: manifest.artifactId, offset: 0, ...data }),
    );
    await expect(collectDesignImage({ call }, {})).rejects.toMatchObject({ code: "IMAGE_CORRUPT" });
    expect(call.mock.calls.at(-1)?.[0]).toBe("release_design_image");
  }
});

it("transfers a PNG larger than one relay frame through multiple bounded chunks", async () => {
  const raster = new PNG({ width: 1100, height: 1000 });
  randomFillSync(raster.data);
  const bytes = PNG.sync.write(raster, { deflateLevel: 0, filterType: 0 });
  expect(bytes.length).toBeGreaterThan(3_950_000);
  const large = {
    ...manifest,
    width: 1100,
    height: 1000,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === "export_design_image") return envelope(large);
    if (method === "release_design_image") return envelope({ released: true });
    const offset = Number(args.offset);
    const chunk = bytes.subarray(offset, offset + AGENT_IMAGE_CHUNK_BYTES);
    expect(chunk.length).toBeLessThanOrEqual(AGENT_IMAGE_CHUNK_BYTES);
    return envelope({
      artifactId: manifest.artifactId,
      offset,
      nextOffset: offset + chunk.length,
      data: chunk.toString("base64"),
    });
  });
  expect(Buffer.from((await collectDesignImage({ call }, {})).data, "base64").equals(bytes)).toBe(
    true,
  );
  expect(call.mock.calls.length).toBeGreaterThan(20);
});

it("surfaces browser revision errors without returning an old image", async () => {
  const call = vi.fn(async () => ({
    ok: false,
    error: { code: "REVISION_CONFLICT", message: "changed" },
  }));
  await expect(collectDesignImage({ call }, {})).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
  });
});

it("requests full-board detail and binds temporary captures to design and revision", async () => {
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  events.addEventListener(FLOW_IMAGE_EXPORT_EVENT, (event) => {
    const request = (event as CustomEvent).detail;
    expect(request).toMatchObject({ capture: true, cardDetail: "full", hideAnnotations: false });
    events.dispatchEvent(
      new CustomEvent(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, {
        detail: { requestId: request.requestId, capture: { blob: new Blob([new Uint8Array(png)]) } },
      }),
    );
  });
  const owner = { designId: "allowed", revision: 2 };
  const current = vi.fn();
  const image = await captureAgentImage(owner, "line/test", current);
  expect(image.name).toBe("line_test.png");
  expect(image.width).toBe(20);
  expect(current).toHaveBeenCalledTimes(2);
  expect(Buffer.from((await agentImageChunk(image.artifactId, 0, owner)).data, "base64")).toEqual(
    png,
  );
  await expect(
    agentImageChunk(image.artifactId, 0, { ...owner, designId: "other" }),
  ).rejects.toMatchObject({ code: "IMAGE_EXPIRED" });
  await expect(
    agentImageChunk(image.artifactId, 0, { ...owner, revision: 3 }),
  ).rejects.toMatchObject({ code: "IMAGE_EXPIRED" });
  await expect(
    agentImageChunk(image.artifactId, AGENT_IMAGE_CHUNK_BYTES, owner),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  clearAgentImages();
  await expect(agentImageChunk(image.artifactId, 0, owner)).rejects.toMatchObject({
    code: "IMAGE_EXPIRED",
  });
});

it("times out cleanly when the board never answers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  const capture = captureAgentImage({ designId: "allowed", revision: 1 }, "factory", () => {});
  const rejected = expect(capture).rejects.toMatchObject({ code: "IMAGE_EXPORT_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(45_000);
  await rejected;
});
