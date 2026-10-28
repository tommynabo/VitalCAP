import type { SearchSeed } from "@/domain/discovery/types";
import {
  APIFY_DEFAULT_BATCH_COST_LIMIT_USD,
  APIFY_MAX_RESULTS_PER_SEARCH,
  resolveApifyMaxResults,
} from "./apify-request-capacity";

export const SEED_ECONOMICS_POLICY = {
  minimumRuns: 3,
  minimumItems: 50,
  zeroNoveltyRunsBeforeCooldown: 2,
  zeroNoveltyCooldownDays: 7,
  lowEconomicCooldownHours: 24,
  extremelyLowNoveltyThreshold: 0.03,
  explorationFraction: 0.12,
  pressuredExplorationFraction: 0.05,
  explorationMaxResults: 20,
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

export interface SeedBatchPlanningResult {
  batches: SeedBatchPlan[];
  coreRequestedItems: number;
  explorationRequestedItems: number;
  productiveSeedCapacityConstrained: boolean;
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

function lowEconomicCooldownUntil(performance: SeedEconomicPerformance | undefined, noveltyRate: number | null): Date | null {
  if (
    !performance
    || performance.recentRuns < SEED_ECONOMICS_POLICY.minimumRuns
    || performance.sampleSize < SEED_ECONOMICS_POLICY.minimumItems
    || performance.outcomeAttributionComplete !== true
    || noveltyRate === null
    || noveltyRate > SEED_ECONOMICS_POLICY.extremelyLowNoveltyThreshold
    || (performance.confirmedInstantlyImportsFromSeed ?? 0) > 0
    || !performance.lastRunAt
  ) return null;
  const lastRun = new Date(performance.lastRunAt);
  if (Number.isNaN(lastRun.getTime())) return null;
  return new Date(lastRun.getTime() + SEED_ECONOMICS_POLICY.lowEconomicCooldownHours * 60 * 60 * 1000);
}

export function scoreSeedEconomicPerformance(
  seed: SearchSeed,
  performance: SeedEconomicPerformance | undefined,
  now: Date,
  medianCostPerConfirmedImport: number | null = null,
  medianCostPerNewRaw: number | null = null,
): SeedEconomicPolicyResult {
  const confident = isSampleConfident(performance);
  const noveltyRate = clampRate(performance?.noveltyRate);
  const coolingUntil = confident
    ? cooldownUntil(performance) ?? lowEconomicCooldownUntil(performance, noveltyRate)
    : null;
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
  if (
    confident
    && (performance?.costPerNewRaw ?? 0) > 0
    && medianCostPerNewRaw !== null
    && medianCostPerNewRaw > 0
  ) {
    const rawCostWeight = Math.sqrt(medianCostPerNewRaw / performance!.costPerNewRaw!);
    priorityScore *= Math.max(
      SEED_ECONOMICS_POLICY.costWeightFloor,
      Math.min(SEED_ECONOMICS_POLICY.costWeightCeiling, rawCostWeight),
    );
  }

  return {
    tier,
    priorityScore,
    maxResults: Math.min(maxResults, SEED_ECONOMICS_POLICY.maxResultsPerSeed),
    eligible: true,
    exploration: tier === "zero" || Boolean(coolingUntil),
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
  configuredMaxResults?: number;
  batchCostLimitUsd?: number;
  economicPressure?: boolean;
}): SeedBatchPlanningResult {
  const target = Math.max(0, Math.floor(input.rawNeeded));
  const seedLimit = Math.max(0, Math.floor(input.maxSeeds));
  if (target === 0 || seedLimit === 0) {
    return { batches: [], coreRequestedItems: 0, explorationRequestedItems: 0, productiveSeedCapacityConstrained: target > 0 };
  }

  const confidentCosts = [...input.performanceBySeed.values()]
    .filter((item) => (item.confirmedInstantlyImportsFromSeed ?? 0) >= SEED_ECONOMICS_POLICY.minConfirmedImportsForCostWeight)
    .map((item) => item.costPerConfirmedImport)
    .filter((value): value is number => value !== null && value !== undefined && value > 0);
  const medianCost = median(confidentCosts);
  const confidentRawCosts = [...input.performanceBySeed.values()]
    .filter((item) => isSampleConfident(item))
    .map((item) => item.costPerNewRaw)
    .filter((value): value is number => value !== null && value !== undefined && value > 0);
  const medianCostPerNewRaw = median(confidentRawCosts);
  const candidates = input.seeds
    .map((seed, index) => ({
      seed,
      index,
      policy: scoreSeedEconomicPerformance(seed, input.performanceBySeed.get(seed.id), input.now, medianCost, medianCostPerNewRaw),
    }))
    .filter(({ seed, policy }) => policy.eligible
      && (!seed.nextEligibleAt || new Date(seed.nextEligibleAt).getTime() <= input.now.getTime()))
    .sort((left, right) => right.policy.priorityScore - left.policy.priorityScore || left.index - right.index);
  if (candidates.length === 0) {
    return { batches: [], coreRequestedItems: 0, explorationRequestedItems: 0, productiveSeedCapacityConstrained: true };
  }

  const coreCandidates = candidates.filter(({ policy }) => !policy.exploration && policy.tier !== "zero");
  const explorationCandidates = candidates.filter(({ policy }) => policy.exploration);
  const hasProtectedSupply = coreCandidates.some(({ policy }) => policy.tier === "high" || policy.tier === "good");
  const hasMatureWeakSupply = coreCandidates.some(({ seed, policy }) => {
    const performance = input.performanceBySeed.get(seed.id);
    return policy.tier === "marginal" || policy.tier === "low"
      ? isSampleConfident(performance)
      : false;
  });
  const economicPressureActive = Boolean(input.economicPressure && hasProtectedSupply && hasMatureWeakSupply);
  const explorationTarget = explorationCandidates.length > 0
    ? Math.floor(target * (economicPressureActive
      ? SEED_ECONOMICS_POLICY.pressuredExplorationFraction
      : SEED_ECONOMICS_POLICY.explorationFraction))
    : 0;
  const providerMaximum = input.configuredMaxResults ?? APIFY_MAX_RESULTS_PER_SEARCH;
  const batchCostLimitUsd = input.batchCostLimitUsd ?? APIFY_DEFAULT_BATCH_COST_LIMIT_USD;
  const maxExplorationCandidateCapacity = Math.max(0, ...explorationCandidates.map(({ policy }) =>
    resolveApifyMaxResults({
      requestedItems: policy.maxResults,
      configuredMaxResults: providerMaximum,
      batchCostLimitUsd,
    }),
  ));
  const desiredExplorationSlots = Math.min(
    explorationCandidates.length,
    maxExplorationCandidateCapacity > 0 ? Math.ceil(explorationTarget / maxExplorationCandidateCapacity) : 0,
  );
  const selectedCore: typeof candidates = [];
  const selectedCoreIds = new Set<string>();
  const selectedGeographies = new Set<string>();
  const coreTarget = target - explorationTarget;
  let selectedCoreCapacity = 0;
  const coreTierOrder = economicPressureActive
    ? ["high", "good"] as const
    : ["high", "good", "marginal", "low"] as const;
  for (const tier of coreTierOrder) {
    const tierCandidates = coreCandidates.filter(({ policy }) => policy.tier === tier);
    const remainingCandidates = tierCandidates.filter(({ seed }) => !selectedCoreIds.has(seed.id));
    while (selectedCore.length < seedLimit && selectedCoreCapacity < coreTarget && remainingCandidates.length > 0) {
      const [candidate] = selectWithGeographySpread(remainingCandidates, 1, selectedGeographies);
      if (!candidate) break;
      selectedCore.push(candidate);
      selectedCoreIds.add(candidate.seed.id);
      selectedGeographies.add(candidate.seed.geography);
      remainingCandidates.splice(remainingCandidates.findIndex(({ seed }) => seed.id === candidate.seed.id), 1);
      selectedCoreCapacity += resolveApifyMaxResults({
        requestedItems: candidate.policy.maxResults,
        configuredMaxResults: providerMaximum,
        batchCostLimitUsd,
      });
    }
  }
  const explorationSlots = Math.min(desiredExplorationSlots, seedLimit - selectedCore.length);
  const selectedExploration = selectWithGeographySpread(
    explorationCandidates,
    explorationSlots,
    selectedGeographies,
  );
  const selected = [...selectedCore, ...selectedExploration];
  const allocation = new Map<string, number>();
  let coreRemaining = Math.max(0, target - (selectedExploration.length > 0 ? explorationTarget : 0));
  for (const candidate of selectedCore) {
    if (coreRemaining <= 0) break;
    const maxResults = resolveApifyMaxResults({
      requestedItems: candidate.policy.maxResults,
      configuredMaxResults: providerMaximum,
      batchCostLimitUsd,
    });
    const requestedItems = Math.min(maxResults, coreRemaining);
    if (requestedItems > 0) {
      allocation.set(candidate.seed.id, requestedItems);
      coreRemaining -= requestedItems;
    }
  }

  let explorationRemaining = explorationTarget;
  for (const candidate of selectedExploration) {
    if (explorationRemaining <= 0) break;
    const maxResults = resolveApifyMaxResults({
      requestedItems: candidate.policy.maxResults,
      configuredMaxResults: providerMaximum,
      batchCostLimitUsd,
    });
    const requestedItems = Math.min(maxResults, explorationRemaining);
    if (requestedItems > 0) {
      allocation.set(candidate.seed.id, requestedItems);
      explorationRemaining -= requestedItems;
    }
  }

  const batches = selected
    .map(({ seed, policy }) => ({ seed, policy, requestedItems: allocation.get(seed.id) ?? 0 }))
    .filter((batch) => batch.requestedItems > 0)
    .sort((left, right) => right.policy.priorityScore - left.policy.priorityScore);
  const coreRequestedItems = batches.filter((batch) => !batch.policy.exploration)
    .reduce((sum, batch) => sum + batch.requestedItems, 0);
  const explorationRequestedItems = batches.filter((batch) => batch.policy.exploration)
    .reduce((sum, batch) => sum + batch.requestedItems, 0);
  const totalRequestedItems = coreRequestedItems + explorationRequestedItems;

  return {
    batches,
    coreRequestedItems,
    explorationRequestedItems,
    productiveSeedCapacityConstrained: totalRequestedItems < target,
  };
}