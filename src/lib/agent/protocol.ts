import { z } from "zod";

export const AGENT_PROTOCOL = 1;
export const resourceRefSchema = z
  .object({
    kind: z.enum(["item", "fluid", "aspect", "power"]),
    id: z.string().min(1).max(512),
  })
  .strict();
const id = z.string().min(1).max(512);
const rate = z.number().finite().nonnegative();
const position = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const machinePatchSchema = z
  .object({
    machineHandlerId: id.optional(),
    overclockTier: id.optional(),
    machineCount: rate.optional(),
    parallel: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    machineConfigTiers: z.record(id, id).optional(),
    coilTier: id.optional(),
    energyHatches: z.number().int().min(1).max(64).optional(),
    energyHatchType: id.optional(),
    hatchVoltageTier: id.optional(),
    hatchAmps: rate.optional(),
    powerEuT: rate.optional(),
    powerInputMode: z.enum(["amps", "eut"]).optional(),
    solvePin: rate.nullable().optional(),
    solvePinExact: z.boolean().optional(),
    solvePinAny: z.boolean().optional(),
    position: position.optional(),
  })
  .strict();
export const portRefSchema = z
  .object({
    entityId: id,
    section: z.number().int().nonnegative().default(0),
    port: z.number().int().nonnegative().default(0),
  })
  .strict();
export const agentActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("add_recipe"),
      ref: id,
      recipeId: id,
      settings: machinePatchSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("update_machine"), nodeId: id, settings: machinePatchSchema })
    .strict(),
  z.object({ type: z.literal("replace_recipe"), nodeId: id, recipeId: id }).strict(),
  z.object({ type: z.literal("add_recipe_section"), nodeId: id, recipeId: id }).strict(),
  z
    .object({
      type: z.literal("remove_recipe_section"),
      nodeId: id,
      section: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("select_input"),
      nodeId: id,
      section: z.number().int().nonnegative().default(0),
      port: z.number().int().nonnegative(),
      resource: resourceRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("add_drawer"),
      ref: id,
      resource: resourceRefSchema,
      role: z.enum(["source", "product", "byproduct", "trash", "buffer"]),
      rate: rate.optional(),
      rule: z.enum(["at-least", "at-most", "exact", "ignore"]).default("ignore"),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_drawer_rule"),
      drawerId: id,
      rate: rate.optional(),
      rule: z.enum(["at-least", "at-most", "exact", "ignore"]),
      drainMode: z.enum(["product", "byproduct", "trash"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("connect"),
      ref: id.optional(),
      source: portRefSchema,
      target: portRefSchema,
    })
    .strict(),
  z.object({ type: z.literal("disconnect"), edgeId: id }).strict(),
  z.object({ type: z.literal("remove_entity"), entityId: id }).strict(),
  z
    .object({
      type: z.literal("set_port_rate"),
      port: portRefSchema,
      side: z.enum(["input", "output"]),
      rate: z.number().finite().positive().nullable(),
    })
    .strict(),
]);
export const actionsSchema = z.array(agentActionSchema).min(1).max(200);
export type AgentAction = z.infer<typeof agentActionSchema>;
export type PortRef = z.infer<typeof portRefSchema>;
export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const constraintsSchema = z
  .object({
    targets: z
      .array(
        z
          .object({ resource: resourceRefSchema, perSecond: z.number().finite().positive() })
          .strict(),
      )
      .min(1),
    maxTier: id,
    allowedInputs: z.array(
      z.object({ resource: resourceRefSchema, maxPerSecond: rate.optional() }).strict(),
    ),
    allowedOutputs: z.array(resourceRefSchema).default([]),
    powerBudgetEuT: rate.optional(),
  })
  .strict();
export type PlanningConstraints = z.infer<typeof constraintsSchema>;

export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function errorResult(error: unknown) {
  return error instanceof AgentError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) };
}

export const browserCommandSchema = z
  .object({
    requestId: id,
    method: z.enum([
      "list_designs",
      "create_design",
      "open_design",
      "get_design",
      "apply_design_actions",
      "evaluate_design",
      "arrange_design",
      "undo_design",
      "redo_design",
      "export_design",
      "export_design_image",
      "get_design_image_chunk",
      "release_design_image",
      "get_machine_options",
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type BrowserCommand = z.infer<typeof browserCommandSchema>;

export interface DatasetIdentity {
  versionId: string;
  fingerprint: string;
}
