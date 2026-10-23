import { z } from "zod";

export const RELAY_PROTOCOL = 1;
export const RELAY_SOCKET_PATH = "/agent/ws";
export const RELAY_PAIRING_PREFIX = "gtnh-relay.";
export const relayId = z.string().min(1).max(512);
export const browserStatusSchema = z.object({
  sessionId: relayId,
  revision: z.number().int().nonnegative(),
  designId: relayId.optional(),
  dataset: z.object({ versionId: relayId, fingerprint: relayId }).optional(),
  readOnly: z.boolean().optional(),
  saveState: z.string().max(40).optional(),
});
export const relayCodeSchema = z
  .object({
    v: z.literal(RELAY_PROTOCOL),
    origin: z.string().url(),
    pairingId: relayId,
    userCode: z.string().regex(/^[A-Z2-7]{12}$/),
  })
  .strict();
export const relayApprovalSchema = z
  .object({
    pairingId: relayId,
    userCode: z.string().regex(/^[A-Z2-7]{12}$/),
    status: browserStatusSchema,
    allowCreate: z.boolean().default(false),
  })
  .strict();
export const relayGrantSchema = z.object({
  pairingId: relayId,
  sessionId: relayId,
  designIds: z.array(relayId).max(100),
  allowCreate: z.boolean(),
  expiresAt: z.number(),
});
export type RelayGrant = z.infer<typeof relayGrantSchema>;
export type RelayStatus = z.infer<typeof browserStatusSchema>;

export function relaySocketUrl(origin: string) {
  const url = new URL(RELAY_SOCKET_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
