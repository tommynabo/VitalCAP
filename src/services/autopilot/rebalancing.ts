import type { ProviderHealthStatus } from "@/domain/autopilot/types";

export interface CampaignPerformance {
  campaignId: string;
  engineType: "maps_fast";
  recentRaw: number;
  recentQualified: number;
  sampleSize: number;
  providerCostUsd: number | null;
  providerHealth: ProviderHealthStatus;
  seedExhaustion: number;
  queueDepth: number;
  activeRuns: number;
  allocatedRaw: number;
}

export interface RebalanceAction {
  fromCampaignId: string | null;
  toCampaignId: string;
  engineType: "maps_fast";
  amount: number;
  score: number;
  reason: string;
}

export interface RebalancePlanInput {
  performances: readonly CampaignPerformance[];
  uncoveredRaw: number;
  now: Date;
  lastRebalanceAt?: Date | null;
  cooldownMinutes?: number;
  minimumImprovement?: number;
  minimumSampleSize?: number;
}

export function campaignScore(performance: CampaignPerformance, minimumSampleSize = 20): number {
  if (performance.providerHealth !== "healthy") return 0;
  const observedYield = performance.recentRaw > 0 ? performance.recentQualified / performance.recentRaw : 0;
  const confidence = Math.min(1, performance.sampleSize / minimumSampleSize);
  const confidenceAdjustedYield = 0.15 * (1 - confidence) + observedYield * confidence;
  const yieldScore = 0.6 * (0.5 + confidenceAdjustedYield);
  const costPerQualified = performance.providerCostUsd !== null && performance.recentQualified > 0
    ? performance.providerCostUsd / performance.recentQualified
    : null;
  const costScore = costPerQualified === null ? 0.15 : 0.25 / Math.max(0.01, costPerQualified);
  const exhaustionPenalty = Math.min(0.25, performance.seedExhaustion * 0.25);
  const queuePenalty = Math.min(0.1, performance.queueDepth / 1000);
  return Math.max(0, yieldScore + Math.min(0.35, costScore) - exhaustionPenalty - queuePenalty);
}

export function planRebalancing(input: RebalancePlanInput): RebalanceAction[] {
  const cooldown = input.cooldownMinutes ?? 30;
  if (input.lastRebalanceAt && input.now.getTime() - input.lastRebalanceAt.getTime() < cooldown * 60_000) return [];
  if (input.uncoveredRaw <= 0) return [];

  const scored = input.performances
    .map((performance) => ({ performance, score: campaignScore(performance, input.minimumSampleSize ?? 20) }))
    .filter(({ performance, score }) => performance.providerHealth === "healthy" && score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return [];

  const donors = input.performances.filter((performance) => performance.campaignId !== best.performance.campaignId && performance.allocatedRaw > 0);
  const donor = donors.sort((a, b) => b.allocatedRaw - a.allocatedRaw)[0] ?? null;
  const donorScore = donor ? campaignScore(donor, input.minimumSampleSize ?? 20) : best.score;
  if (donor && best.score < donorScore + (input.minimumImprovement ?? 0.15)) return [];

  const amount = Math.min(Math.max(1, Math.ceil(input.uncoveredRaw)), donor?.allocatedRaw ?? input.uncoveredRaw);
  return [{
    fromCampaignId: donor?.campaignId ?? null,
    toCampaignId: best.performance.campaignId,
    engineType: "maps_fast",
    amount,
    score: best.score,
    reason: `rebalance: Maps Fast score ${best.score.toFixed(3)}; uncovered raw capacity ${amount}; healthy provider and Spain/ICP constraints preserved.`,
  }];
}