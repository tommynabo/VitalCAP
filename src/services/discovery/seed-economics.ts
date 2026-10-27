import type { SearchSeed } from "@/domain/discovery/types";

export const SEED_ECONOMICS_POLICY = {
  minimumRuns: 3,
  minimumItems: 50,
  zeroNoveltyRunsBeforeCooldown: 2,
  zeroNoveltyCooldownDays: 7,
  explorationFraction: 0.12,
  explorationMaxResults: 40,
  returningSeedMaxResults: 20,
  highNoveltyThreshold: 0.5,
  goodNoveltyThreshold: 0.25,
  marginalNoveltyThreshold: 0.1,
  highMaxResults: 100,
  goodMaxResults: 100,
  marginalMaxResults: 35,
  lowMaxResults: 15,
  zeroMaxResults: 10,
  maxResultsPerSeed: 100,
  minConfirmedImportsForCostWeight: 5,
  minDownstreamOutcomesForYield: 5,
  minQualifiedOutcomesForYield: 10,
  costWeightFloor: 0.75,
  costWeightCeiling: 1.25,
} as const;

export interface SeedEconomicPerformance {
  seedId: string;
  recentRuns: number;
  itemsReturned: number;
  newRaw: number;
  duplicates: number;
  noveltyRate: number | null;
  providerCostUsd: number;
  providerCostTodayUsd: number;
  outcomeAttributionComplete: boolean;
  itemsReturnedToday: number;
  newRawToday: number;
  duplicatesToday: number;
  costPerNewRaw: number | null;
  qualifiedFromSeed: number | null;
  websiteFromSeed: number | null;
  emailFoundFromSeed: number | null;
  validEmailFromSeed: number | null;
  confirmedInstantlyImportsFromSeed: number | null;
  qualifiedYield: number | null;
  websiteRate: number | null;
  emailFoundRate: number | null;
  validEmailYield: number | null;
  validEmailRate: number | null;
  confirmedImportYield: number | null;
  instantlyImportRate: number | null;
  costPerConfirmedImport: number | null;
  sampleSize: number;
  zeroNoveltyRunStreak: number;
  lastRunAt: string | null;
  nextEligibleAt: string | null;
}

export type SeedNoveltyTier = "exploration" | "high" | "good" | "marginal" | "low" | "zero";

export interface SeedEconomicPolicyResult {
  tier: SeedNoveltyTier;
  priorityScore: number;
  maxResults: number;
  eligible: boolean;
  exploration: boolean;
  cooldownUntil: string | null;
}

export interface SeedBatchPlan {
  seed: SearchSeed;
  requestedItems: number;
  policy: SeedEconomicPolicyResult;
}

function clampRate(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

export function calculateSeedNoveltyRate(insertedNewRaw: number, itemsReturned: number): number | null {
  if (itemsReturned <= 0) return null;
  return Math.max(0, Math.min(1, insertedNewRaw / itemsReturned));
}

function isSampleConfident(performance: SeedEconomicPerformance | undefined): boolean {
  return Boolean(performance && (
    performance.recentRuns >= SEED_ECONOMICS_POLICY.minimumRuns
    || performance.itemsReturned >= SEED_ECONOMICS_POLICY.minimumItems
  ));
}

function downstreamYield(performance: SeedEconomicPerformance | undefined): number {
  if (!performance) return 0.1;
  if ((performance.confirmedInstantlyImportsFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minDownstreamOutcomesForYield) {
    return clampRate(performance.confirmedImportYield) ?? 0.1;
  }
  if ((performance.validEmailFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minDownstreamOutcomesForYield) {
    return clampRate(performance.validEmailYield) ?? 0.1;
  }
  if ((performance.qualifiedFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minQualifiedOutcomesForYield) {
    return clampRate(performance.qualifiedYield) ?? 0.1;
  }
  return 0.1;
}

function cooldownUntil(performance: SeedEconomicPerformance | undefined): Date | null {
  if (!performance?.lastRunAt || performance.zeroNoveltyRunStreak < SEED_ECONOMICS_POLICY.zeroNoveltyRunsBeforeCooldown) return null;
  const lastRun = new Date(performance.lastRunAt);
  if (Number.isNaN(lastRun.getTime())) return null;
  return new Date(lastRun.getTime() + SEED_ECONOMICS_POLICY.zeroNoveltyCooldownDays * 24 * 60 * 60 * 1000);
}

export function scoreSeedEconomicPerformance(
  seed: SearchSeed,
  performance: SeedEconomicPerformance | undefined,
  now: Date,
  medianCostPerConfirmedImport: number | null = null,
): SeedEconomicPolicyResult {
  const confident = isSampleConfident(performance);
  const noveltyRate = clampRate(performance?.noveltyRate);
  const coolingUntil = confident && noveltyRate === 0 ? cooldownUntil(performance) : null;
  if (coolingUntil && now.getTime() < coolingUntil.getTime()) {
    return {
      tier: "zero",
      priorityScore: 0,
      maxResults: 0,
      eligible: false,
      exploration: false,
      cooldownUntil: coolingUntil.toISOString(),
    };
  }

  if (!confident || noveltyRate === null) {
    const qualityPrior = clampRate(seed.yieldRate) ?? 0;
    return {
      tier: "exploration",
      priorityScore: 0.2 + qualityPrior * 0.1,
      maxResults: Math.min(SEED_ECONOMICS_POLICY.explorationMaxResults, SEED_ECONOMICS_POLICY.maxResultsPerSeed),
      eligible: true,
      exploration: true,
      cooldownUntil: coolingUntil?.toISOString() ?? null,
    };
  }

  let tier: SeedNoveltyTier;
  let maxResults: number;
  if (noveltyRate >= SEED_ECONOMICS_POLICY.highNoveltyThreshold) {
    tier = "high";
    maxResults = SEED_ECONOMICS_POLICY.highMaxResults;
  } else if (noveltyRate >= SEED_ECONOMICS_POLICY.goodNoveltyThreshold) {
    tier = "good";
    maxResults = SEED_ECONOMICS_POLICY.goodMaxResults;
  } else if (noveltyRate >= SEED_ECONOMICS_POLICY.marginalNoveltyThreshold) {
    tier = "marginal";
    maxResults = SEED_ECONOMICS_POLICY.marginalMaxResults;
  } else if (noveltyRate > 0) {
    tier = "low";
    maxResults = SEED_ECONOMICS_POLICY.lowMaxResults;
  } else {
    tier = "zero";
    maxResults = performance?.zeroNoveltyRunStreak && performance.zeroNoveltyRunStreak >= SEED_ECONOMICS_POLICY.zeroNoveltyRunsBeforeCooldown
      ? SEED_ECONOMICS_POLICY.returningSeedMaxResults
      : SEED_ECONOMICS_POLICY.zeroMaxResults;
  }

  const qualityComponent = downstreamYield(performance);
  let priorityScore = noveltyRate * 0.65 + qualityComponent * 0.35;
  if (
    (performance?.confirmedInstantlyImportsFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minConfirmedImportsForCostWeight
    && performance?.costPerConfirmedImport !== null
    && performance?.costPerConfirmedImport !== undefined
    && medianCostPerConfirmedImport !== null
    && medianCostPerConfirmedImport > 0
    && performance.costPerConfirmedImport > 0
  ) {
    const costWeight = Math.sqrt(medianCostPerConfirmedImport / performance.costPerConfirmedImport);
    priorityScore *= Math.max(
      SEED_ECONOMICS_POLICY.costWeightFloor,
      Math.min(SEED_ECONOMICS_POLICY.costWeightCeiling, costWeight),
    );
  }

  return {
    tier,
    priorityScore,
    maxResults: Math.min(maxResults, SEED_ECONOMICS_POLICY.maxResultsPerSeed),
    eligible: true,
    exploration: Boolean(coolingUntil),
    cooldownUntil: coolingUntil?.toISOString() ?? null,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? null;
}

function selectWithGeographySpread<T extends { seed: SearchSeed }>(
  candidates: readonly T[],
  count: number,
  previouslySelectedGeographies: ReadonlySet<string> = new Set(),
): T[] {
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const geographies = new Set(previouslySelectedGeographies);
  for (const candidate of candidates) {
    if (selected.length >= count) break;
    if (geographies.has(candidate.seed.geography)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.seed.id);
    geographies.add(candidate.seed.geography);
  }
  for (const candidate of candidates) {
    if (selected.length >= count) break;
    if (selectedIds.has(candidate.seed.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.seed.id);
  }
  return selected;
}

export function planSeedBatches(input: {
  seeds: readonly SearchSeed[];
  performanceBySeed: ReadonlyMap<string, SeedEconomicPerformance>;
  rawNeeded: number;
  maxSeeds: number;
  now: Date;
}): SeedBatchPlan[] {
  const target = Math.max(0, Math.floor(input.rawNeeded));
  const seedLimit = Math.max(0, Math.floor(input.maxSeeds));
  if (target === 0 || seedLimit === 0) return [];

  const confidentCosts = [...input.performanceBySeed.values()]
    .filter((item) => (item.confirmedInstantlyImportsFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minConfirmedImportsForCostWeight)
    .map((item) => item.costPerConfirmedImport)
    .filter((value): value is number => value !== null && value !== undefined && value > 0);
  const medianCost = median(confidentCosts);
  const candidates = input.seeds
    .map((seed, index) => ({
      seed,
      index,
      policy: scoreSeedEconomicPerformance(seed, input.performanceBySeed.get(seed.id), input.now, medianCost),
    }))
    .filter(({ seed, policy }) => policy.eligible
      && (!seed.nextEligibleAt || new Date(seed.nextEligibleAt).getTime() <= input.now.getTime()))
    .sort((left, right) => right.policy.priorityScore - left.policy.priorityScore || left.index - right.index);
  if (candidates.length === 0) return [];

  const explorationCandidates = candidates.filter(({ policy }) => policy.exploration);
  const explorationTarget = explorationCandidates.length > 0
    ? Math.ceil(target * SEED_ECONOMICS_POLICY.explorationFraction)
    : 0;
  const explorationSlots = Math.min(
    explorationCandidates.length,
    seedLimit,
    Math.ceil(explorationTarget / SEED_ECONOMICS_POLICY.explorationMaxResults),
  );
  const selectedExploration = selectWithGeographySpread(explorationCandidates, explorationSlots);
  const explorationIds = new Set(selectedExploration.map(({ seed }) => seed.id));
  const explorationGeographies = new Set(selectedExploration.map(({ seed }) => seed.geography));
  const selectedCore = selectWithGeographySpread(
    candidates.filter(({ seed }) => !explorationIds.has(seed.id)),
    seedLimit - selectedExploration.length,
    explorationGeographies,
  );
  const selected = [...selectedCore, ...selectedExploration];
  const allocation = new Map<string, number>();

  let remaining = target;
  const reservedExploration = Math.min(
    explorationTarget,
    selectedExploration.reduce((sum, item) => sum + item.policy.maxResults, 0),
  );
  let explorationRemaining = reservedExploration;
  for (const candidate of selectedExploration) {
    const requestedItems = Math.min(candidate.policy.maxResults, explorationRemaining);
    if (requestedItems > 0) {
      allocation.set(candidate.seed.id, requestedItems);
      explorationRemaining -= requestedItems;
      remaining -= requestedItems;
    }
  }

  for (const candidate of selectedCore) {
    if (remaining <= 0) break;
    const requestedItems = Math.min(candidate.policy.maxResults, remaining);
    if (requestedItems > 0) {
      allocation.set(candidate.seed.id, requestedItems);
      remaining -= requestedItems;
    }
  }

  for (const candidate of selectedExploration) {
    if (remaining <= 0) break;
    const alreadyAllocated = allocation.get(candidate.seed.id) ?? 0;
    const requestedItems = Math.min(candidate.policy.maxResults - alreadyAllocated, remaining);
    if (requestedItems > 0) {
      allocation.set(candidate.seed.id, alreadyAllocated + requestedItems);
      remaining -= requestedItems;
    }
  }

  return selected
    .map(({ seed, policy }) => ({ seed, policy, requestedItems: allocation.get(seed.id) ?? 0 }))
    .filter((batch) => batch.requestedItems > 0)
    .sort((left, right) => right.policy.priorityScore - left.policy.priorityScore);
}