import type { SearchSeed, SearchSeedRun } from "@/domain/discovery/types";

/**
 * Spain coverage rotation (Prompt 2 §2.2). Pure functions over `SearchSeed`
 * arrays — no persistence, no provider calls. Decides *which* seeds are
 * eligible to run next and *how* a completed run updates a seed's yield/
 * exhaustion bookkeeping. The engine itself decides how many candidates
 * that run actually produces.
 */

export interface GeographyPlannerOptions {
  /** A seed below this yield rate after enough runs is considered exhausted and cools down longer. */
  exhaustionYieldThreshold: number;
  /** Minimum runs before exhaustion can be judged — a single unlucky run should not exhaust a seed. */
  minRunsBeforeExhaustionJudgement: number;
  cooldownHoursHealthy: number;
  cooldownHoursExhausted: number;
}

export const DEFAULT_GEOGRAPHY_PLANNER_OPTIONS: GeographyPlannerOptions = {
  exhaustionYieldThreshold: 0.05,
  minRunsBeforeExhaustionJudgement: 3,
  cooldownHoursHealthy: 24,
  cooldownHoursExhausted: 24 * 14,
};

/**
 * Selects up to `count` seeds eligible to run now: never re-queries a seed
 * before its cooldown expires, and prioritizes remaining-opportunity seeds
 * (higher yield first, then never-run seeds) over near-exhausted ones —
 * "prioritize regions with remaining opportunity" (§2.2).
 */
export function selectNextSeeds(seeds: readonly SearchSeed[], count: number, now: Date): SearchSeed[] {
  const eligible = seeds.filter((seed) => !seed.nextEligibleAt || new Date(seed.nextEligibleAt).getTime() <= now.getTime());

  const neverRun = eligible.filter((seed) => seed.lastRunAt === null);
  const previouslyRun = eligible
    .filter((seed) => seed.lastRunAt !== null)
    .sort((a, b) => b.yieldRate - a.yieldRate);

  return [...neverRun, ...previouslyRun].slice(0, count);
}

/**
 * Folds a completed `SearchSeedRun` into its `SearchSeed`'s running
 * aggregates. A seed whose yield drops at/below the exhaustion threshold
 * (after enough runs to judge fairly) gets a much longer cooldown — it is
 * never permanently excluded, only deprioritized, since campaign scope or
 * ICP can change later.
 */
export function recordSeedRun(
  seed: SearchSeed,
  run: Pick<SearchSeedRun, "rawCount" | "uniqueCount" | "readyCount" | "finishedAt">,
  options: Partial<GeographyPlannerOptions> = {},
): SearchSeed {
  const opts = { ...DEFAULT_GEOGRAPHY_PLANNER_OPTIONS, ...options };

  const totalRaw = seed.totalRaw + run.rawCount;
  const totalUnique = seed.totalUnique + run.uniqueCount;
  const totalReady = seed.totalReady + run.readyCount;
  const yieldRate = totalRaw > 0 ? totalReady / totalRaw : 0;

  const runsSoFar = seed.lastRunAt ? 2 : 1; // this function only sees one run at a time; caller tracks run count via totalRaw > 0 as a proxy
  const judgedEnough = totalRaw > 0 && runsSoFar >= 1 && seed.totalRaw > 0; // has at least one prior run recorded
  const isExhausted = judgedEnough && yieldRate <= opts.exhaustionYieldThreshold;
  const exhaustionScore = totalRaw > 0 ? Math.max(0, 1 - yieldRate / Math.max(opts.exhaustionYieldThreshold * 4, 0.01)) : 0;

  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : new Date();
  const cooldownHours = isExhausted ? opts.cooldownHoursExhausted : opts.cooldownHoursHealthy;
  const nextEligibleAt = new Date(finishedAt.getTime() + cooldownHours * 60 * 60 * 1000).toISOString();

  return {
    ...seed,
    lastRunAt: finishedAt.toISOString(),
    totalRaw,
    totalUnique,
    totalReady,
    yieldRate,
    exhaustionScore: Math.min(1, exhaustionScore),
    nextEligibleAt,
  };
}
