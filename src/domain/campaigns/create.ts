import { z } from "zod";

const engineTypeSchema = z.enum(["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"]);
const campaignStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).optional().nullable(),
  status: campaignStatusSchema.default("active"),
  engineType: engineTypeSchema,
  dailySoftTarget: z.number().int().min(1).max(250),
  autopilotEnabled: z.boolean().default(true),
  engineConfig: z.record(z.string(), z.unknown()).default({}),
  desiredChannelMix: z.object({
    email: z.number().int().min(0).max(100),
    sms: z.number().int().min(0).max(100),
  }).refine((mix) => mix.email + mix.sms === 100, "Channel mix must total 100.").default({ email: 100, sms: 0 }),
  offerId: z.uuid().optional(),
});

export type CreateCampaignCommand = z.infer<typeof createCampaignSchema>;
