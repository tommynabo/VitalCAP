import { z } from "zod";

const targetMetricSchema = z.enum(["qualified", "analyzed_qualified", "outreach_ready", "instantly_imported"]);

export const autopilotControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("emergency_stop") }),
  z.object({ action: z.literal("clear_emergency_stop") }),
  z.object({
    action: z.literal("target_change"),
    globalDailyTarget: z.number().int().min(1).max(250),
    targetMetric: targetMetricSchema.optional(),
  }),
]);

export type AutopilotControlCommand = z.infer<typeof autopilotControlSchema>;
