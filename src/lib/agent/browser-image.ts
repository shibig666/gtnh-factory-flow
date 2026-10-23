"use client";

import { AgentError } from "./protocol";
import { randomUUID } from "@/lib/random-id";
import {
  AGENT_IMAGE_CHUNK_BYTES,
  MAX_AGENT_IMAGE_BYTES,
  imageManifestSchema,
  type ImageManifest,
} from "./image-protocol";
import {
  FLOW_IMAGE_EXPORT_EVENT,
  FLOW_IMAGE_EXPORT_COMPLETE_EVENT,
  type FlowExportCapture,
} from "@/lib/import-export/plan-image";

type Owner = { designId: string; revision: number };
const images = new Map<
  string,
  { owner: Owner; blob: Blob; timer: ReturnType<typeof setTimeout> }
>();
function remove(id: string) {
  clearTimeout(images.get(id)?.timer);
  images.delete(id);
}
export function clearAgentImages() {
  for (const id of images.keys()) remove(id);
}

function requestCapture(): Promise<FlowExportCapture> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, complete);
    };
    const complete = (event: Event) => {
      const detail = (
        event as CustomEvent<{ requestId?: string; capture?: FlowExportCapture; error?: string }>
      ).detail;
      if (detail?.requestId !== requestId) return;
      cleanup();
      if (!detail.capture?.blob)
        reject(
          new AgentError(
            "IMAGE_EXPORT_FAILED",
            detail.error ?? "Open the plan board before exporting an image.",
          ),
        );
      else resolve(detail.capture);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new AgentError(
          "IMAGE_EXPORT_TIMEOUT",
          "The board did not finish exporting. Keep the plan board open and try again.",
        ),
      );
    }, 45_000);
    window.addEventListener(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, complete);
    window.dispatchEvent(
      new CustomEvent(FLOW_IMAGE_EXPORT_EVENT, {
        detail: {
          requestId,
          format: "png",
          capture: true,
          cardDetail: "full",
          hideAnnotations: false,
        },
      }),
    );
  });
}

/** The ordinary board exporter frames all nodes, independent of the current scroll camera. */
export async function captureAgentImage(
  owner: Owner,
  name: string,
  checkCurrent: () => void,
): Promise<ImageManifest> {
  const capture = await requestCapture();
  checkCurrent();
  const blob = capture.blob!;
  if (blob.size > MAX_AGENT_IMAGE_BYTES)
    throw new AgentError(
      "IMAGE_TOO_LARGE",
      "The complete PNG exceeds 16 MiB. Split this design before exporting to chat.",
    );
  const bytes = await blob.arrayBuffer();
  const header = new DataView(bytes);
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    : (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  checkCurrent();
  const artifactId = randomUUID();
  const manifest = imageManifestSchema.parse({
    artifactId,
    mimeType: "image/png",
    name: `${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100) || "Factory"}.png`,
    width: header.getUint32(16),
    height: header.getUint32(20),
    bytes: blob.size,
    sha256,
  });
  while (images.size >= 2) remove(images.keys().next().value!);
  images.set(artifactId, { owner, blob, timer: setTimeout(() => remove(artifactId), 300_000) });
  return manifest;
}

export async function agentImageChunk(artifactId: string, offset: number, owner: Owner) {
  const image = images.get(artifactId);
  if (!image || image.owner.designId !== owner.designId || image.owner.revision !== owner.revision)
    throw new AgentError(
      "IMAGE_EXPIRED",
      "Export this design image again; its temporary capture is unavailable.",
    );
  if (!Number.isInteger(offset) || offset < 0 || offset >= image.blob.size)
    throw new AgentError("INVALID_REQUEST", "Invalid image offset.");
  const bytes = new Uint8Array(
    await image.blob.slice(offset, offset + AGENT_IMAGE_CHUNK_BYTES).arrayBuffer(),
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { artifactId, offset, data: btoa(binary), nextOffset: offset + bytes.length };
}
export function releaseAgentImage(id: string) {
  remove(id);
  return { released: true };
}
