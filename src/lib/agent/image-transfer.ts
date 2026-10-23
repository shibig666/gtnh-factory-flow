import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentConnection } from "./connection";
import { AgentError } from "./protocol";
import { AGENT_IMAGE_CHUNK_BYTES, imageManifestSchema, type DesignImage } from "./image-protocol";

function browserValue(result: unknown): unknown {
  const envelope = z
    .object({
      ok: z.boolean(),
      value: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .parse(result);
  if (!envelope.ok)
    throw new AgentError(
      envelope.error?.code ?? "IMAGE_EXPORT_FAILED",
      envelope.error?.message ?? "Image export failed.",
    );
  return envelope.value;
}

/** Bounded chunks keep large PNGs below both local and relay WebSocket frame limits. */
export async function collectDesignImage(
  bridge: Pick<AgentConnection, "call">,
  target: Record<string, unknown>,
): Promise<DesignImage> {
  const manifest = imageManifestSchema.parse(
    browserValue(await bridge.call("export_design_image", target)),
  );
  const { artifactId } = manifest;
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < manifest.bytes) {
      const chunk = z
        .object({
          artifactId: z.literal(artifactId),
          offset: z.literal(offset),
          nextOffset: z.number().int(),
          data: z.string().max((AGENT_IMAGE_CHUNK_BYTES * 4) / 3),
        })
        .parse(
          browserValue(
            await bridge.call("get_design_image_chunk", { ...target, artifactId, offset }),
          ),
        );
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        bytes.length === 0 ||
        bytes.toString("base64") !== chunk.data ||
        chunk.nextOffset !== offset + bytes.length ||
        chunk.nextOffset > manifest.bytes
      )
        throw new AgentError(
          "IMAGE_CORRUPT",
          "Image transfer was incomplete. Export the image again.",
        );
      chunks.push(bytes);
      offset = chunk.nextOffset;
    }
    const png = Buffer.concat(chunks);
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.readUInt32BE(16) !== manifest.width ||
      png.readUInt32BE(20) !== manifest.height ||
      createHash("sha256").update(png).digest("hex") !== manifest.sha256
    )
      throw new AgentError("IMAGE_CORRUPT", "The received PNG does not match its capture.");
    return { kind: "gtnh-design-image", ...manifest, data: png.toString("base64") };
  } finally {
    try {
      await bridge.call("release_design_image", { ...target, artifactId });
    } catch {
      /* Disconnected captures expire in the bounded browser cache. */
    }
  }
}
