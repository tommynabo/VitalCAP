import { z } from "zod";

/** The operational campaign controls exposed by the dashboard. */
export const updateCampaignSchema = z.object({
  id: z.uuid(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  autopilotEnabled: z.boolean().optional(),
  dailySoftTarget: z.number().int().min(1).max(250).optional(),
}).strict().refine(
  (command) => command.status !== undefined || command.autopilotEnabled !== undefined || command.dailySoftTarget !== undefined,
  "At least one campaign setting must be supplied.",
);

export type UpdateCampaignCommand = z.infer<typeof updateCampaignSchema>;
