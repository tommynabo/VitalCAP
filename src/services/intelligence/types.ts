import { z } from "zod";

export const ProspectContextSchema = z.object({
  workspaceId: z.string(),
  campaignId: z.string(),
  accountId: z.string(),
  account: z.object({
    normalizedName: z.string(),
    normalizedDomain: z.string().nullable(),
    businessType: z.string(),
    location: z.object({
      city: z.string().nullable(),
      region: z.string().nullable(),
      country: z.string().nullable(),
    }),
    metrics: z.object({
      rating: z.number().nullable(),
      reviewCount: z.number().nullable(),
    }),
  }),
  offer: z.object({
    name: z.string(),
    company: z.string(),
    description: z.string(),
    primaryCta: z.string(),
    approvedClaims: z.array(z.string()),
    forbiddenClaims: z.array(z.string()),
  }),
  campaign: z.object({
    name: z.string(),
    description: z.string().nullable(),
  }),
  evidence: z.object({
    website: z.object({
      textContent: z.string().nullable(),
      scrapedAt: z.string().nullable(),
    }),
    maps: z.object({
      categories: z.array(z.string()),
      summary: z.string().nullable(),
      reviews: z.array(
        z.object({
          text: z.string(),
          rating: z.number(),
        })
      ),
    }),
  }),
});

export type ProspectContext = z.infer<typeof ProspectContextSchema>;
