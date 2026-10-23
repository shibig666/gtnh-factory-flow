import { z } from "zod";

export const MAX_AGENT_IMAGE_BYTES = 16 * 1024 * 1024;
export const AGENT_IMAGE_CHUNK_BYTES = 192 * 1024;
export const imageManifestSchema = z.object({
  artifactId: z.string().uuid(),
  mimeType: z.literal("image/png"),
  name: z.string().min(1).max(120),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  bytes: z.number().int().positive().max(MAX_AGENT_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ImageManifest = z.infer<typeof imageManifestSchema>;
export interface DesignImage extends ImageManifest {
  kind: "gtnh-design-image";
  data: string;
}
export function isDesignImage(value: unknown): value is DesignImage {
  return (
    !!value && typeof value === "object" && "kind" in value && value.kind === "gtnh-design-image"
  );
}
export function imageMetadata(image: DesignImage) {
  const { data: _data, ...metadata } = image;
  void _data;
  return metadata;
}
