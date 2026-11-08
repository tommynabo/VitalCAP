import type { NicheId } from "@/services/discovery/niche-profiles";

export const MULTI_NICHE_ROLLOUT = [
  {
    campaignId: "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
    niche: "yoga_pilates",
    expectedTarget: "7ba53c91-6c8f-4b8a-b260-72eb48f62d07",
  },
  {
    campaignId: "5e109452-2df2-4b1b-9afc-7baa1b67fc42",
    niche: "spas_wellness",
    expectedTarget: "20013626-0dc5-4bb4-a2bf-c4b99450cdb6",
  },
  {
    campaignId: "47fce807-aac6-4a8a-90f9-6ad3bbbf4ca7",
    niche: "premium_fitness",
    expectedTarget: "5f42f2cf-5ebc-412e-814f-5eca8b1fea71",
  },
  {
    campaignId: "53f56788-99d9-4d6a-8c71-ab2ffe075d85",
    niche: "personal_training",
    expectedTarget: "2413f6f5-2e21-46c2-addc-9b8c2ff90a34",
  },
] as const satisfies readonly { campaignId: string; niche: NicheId; expectedTarget: string }[];

export const MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS = MULTI_NICHE_ROLLOUT.map((item) => item.campaignId);

export function getMultiNicheRolloutEntry(campaignId: string) {
  return MULTI_NICHE_ROLLOUT.find((item) => item.campaignId === campaignId) ?? null;
}