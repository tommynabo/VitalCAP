import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { searchSeeds, searchSeedRuns, discoveryJobs, rawCandidates } from "../schema/discovery";
import { campaigns } from "../schema/campaigns";
import type { EngineType } from "@/domain/campaigns/types";
import type { CandidateProcessingMetrics, RawCandidate, SearchSeed, SearchSeedRun } from "@/domain/discovery/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { recomputeSeedMetrics, recordSeedRun } from "@/services/discovery/geography-planner";
import { calculateSeedNoveltyRate, type SeedEconomicPerformance } from "@/services/discovery/seed-economics";

function toSearchSeed(row: typeof searchSeeds.$inferSelect): SearchSeed {
  return {
    id: row.id,
    campaignId: row.campaignId,
    engineType: row.engineType as SearchSeed["engineType"],
    query: row.query,
    geography: row.geography,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    totalRaw: row.totalRaw,
    totalUnique: row.totalUnique,
    totalReady: row.totalReady,
    yieldRate: row.yieldRate,
    exhaustionScore: row.exhaustionScore,
    nextEligibleAt: row.nextEligibleAt?.toISOString() ?? null,
  };
}

function toRawCandidate(row: typeof rawCandidates.$inferSelect): RawCandidate {
  return {
    id: row.id,
    campaignId: row.campaignId,
    engineType: row.engineType as EngineType,
    sourceExternalId: row.sourceExternalId,
    sourceUrl: row.sourceUrl,
    rawPayload: row.rawPayload as Record<string, unknown>,
    processingMetrics: row.processingMetrics as CandidateProcessingMetrics | null,
    searchSeedRunId: row.searchSeedRunId,
    providerRunId: row.providerRunId,
    accountId: row.accountId,
    discoveredAt: row.discoveredAt.toISOString(),
  };
}

export async function listSearchSeeds(workspaceId: string): Promise<SearchSeed[]> {
  const db = getDb();
  const rows = await db
    .select({ seed: searchSeeds })
    .from(searchSeeds)
    .innerJoin(campaigns, eq(searchSeeds.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(({ seed }) => toSearchSeed(seed));
}

/** Every persisted seed for one campaign+engine — feeds a `DiscoveryEngine.seeds` array before `planDiscoveryBatch`/`selectNextSeeds` runs (Gate E). */
export async function listSearchSeedsForCampaignEngine(campaignId: string, engineType: EngineType): Promise<SearchSeed[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(searchSeeds)
    .where(and(eq(searchSeeds.campaignId, campaignId), eq(searchSeeds.engineType, engineType)));
  return rows.map(toSearchSeed);
}

export function buildSeedEconomicPerformanceQuery(campaignId: string, engineType: EngineType, since: Date, todayStart: Date, now: Date) {
  return sql`
    WITH recent_runs AS (
      SELECT run.id, run.started_at, run.campaign_id,
        COALESCE(run.seed_id, NULLIF(run.metadata->>'seedId', '')::uuid) AS seed_id,
        run.items_returned, run.cost_usd,
        NULLIF(run.metadata #>> '{ingestionAccounting,INSERTED_NEW_RAW}', '')::int AS new_raw,
        NULLIF(run.metadata #>> '{ingestionAccounting,DUPLICATE_EXISTING_RAW}', '')::int AS duplicates,
        (NULLIF(run.metadata #>> '{ingestionAccounting,INSERTED_NEW_RAW}', '') IS NOT NULL
          AND NULLIF(run.metadata #>> '{ingestionAccounting,DUPLICATE_EXISTING_RAW}', '') IS NOT NULL) AS has_accounting
      FROM provider_runs run
      WHERE run.campaign_id = ${campaignId}::uuid
        AND run.provider = 'apify'
        AND run.status IN ('ingested', 'completed')
        AND run.started_at >= ${since.toISOString()}::timestamptz
        AND run.started_at < ${now.toISOString()}::timestamptz
        AND COALESCE(run.metadata->>'recoveryProbe', 'false') <> 'true'
        AND COALESCE(run.seed_id, NULLIF(run.metadata->>'seedId', '')::uuid) IS NOT NULL
    ), ordered_runs AS (
      SELECT recent_runs.*,
        SUM(CASE WHEN NOT has_accounting OR items_returned <= 0 OR new_raw > 0 THEN 1 ELSE 0 END)
          OVER (PARTITION BY seed_id ORDER BY started_at DESC, id DESC) AS zero_streak_boundary
      FROM recent_runs
    ), run_rollup AS (
      SELECT seed_id,
        COUNT(*) FILTER (WHERE has_accounting)::int AS recent_runs,
        COALESCE(SUM(items_returned) FILTER (WHERE has_accounting), 0)::int AS items_returned,
        COALESCE(SUM(new_raw) FILTER (WHERE has_accounting), 0)::int AS new_raw,
        COALESCE(SUM(duplicates) FILTER (WHERE has_accounting), 0)::int AS duplicates,
        COALESCE(SUM(cost_usd) FILTER (WHERE has_accounting), 0)::float AS provider_cost_usd,
        COALESCE(SUM(cost_usd) FILTER (WHERE has_accounting AND started_at >= ${todayStart.toISOString()}::timestamptz), 0)::float AS provider_cost_today_usd,
        COALESCE(SUM(items_returned) FILTER (WHERE started_at >= ${todayStart.toISOString()}::timestamptz), 0)::int AS items_returned_today,
        COALESCE(SUM(new_raw) FILTER (WHERE has_accounting AND started_at >= ${todayStart.toISOString()}::timestamptz), 0)::int AS new_raw_today,
        COALESCE(SUM(duplicates) FILTER (WHERE has_accounting AND started_at >= ${todayStart.toISOString()}::timestamptz), 0)::int AS duplicates_today,
        COUNT(*) FILTER (WHERE has_accounting AND items_returned > 0 AND new_raw = 0 AND zero_streak_boundary = 0)::int AS zero_novelty_run_streak,
        MAX(started_at) FILTER (WHERE has_accounting) AS last_run_at
      FROM ordered_runs
      GROUP BY seed_id
    ), raw_mappings AS (
      SELECT DISTINCT run.seed_id, raw.id AS raw_id, raw.campaign_id, raw.account_id
      FROM recent_runs run
      JOIN raw_candidates raw ON raw.provider_run_id = run.id
      WHERE run.has_accounting
    ), seed_accounts AS (
      SELECT DISTINCT seed_id, campaign_id, account_id
      FROM raw_mappings
      WHERE account_id IS NOT NULL
    ), account_seed_counts AS (
      SELECT campaign_id, account_id, COUNT(DISTINCT seed_id)::int AS seed_count
      FROM seed_accounts
      GROUP BY campaign_id, account_id
    ), attributable_accounts AS (
      SELECT source.seed_id, source.campaign_id, source.account_id
      FROM seed_accounts source
      JOIN account_seed_counts counts
        ON counts.campaign_id = source.campaign_id AND counts.account_id = source.account_id
      WHERE counts.seed_count = 1
    ), outcome_coverage AS (
      SELECT mapping.seed_id,
        COUNT(DISTINCT mapping.raw_id)::int AS total_raw,
        COUNT(DISTINCT mapping.raw_id) FILTER (WHERE attributed.account_id IS NOT NULL)::int AS attributable_raw
      FROM raw_mappings mapping
      LEFT JOIN attributable_accounts attributed
        ON attributed.seed_id = mapping.seed_id
          AND attributed.campaign_id = mapping.campaign_id
          AND attributed.account_id = mapping.account_id
      GROUP BY mapping.seed_id
    ), outcome_rollup AS (
      SELECT source.seed_id,
        COUNT(DISTINCT source.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM campaign_memberships membership
          WHERE membership.campaign_id = source.campaign_id
            AND membership.account_id = source.account_id
            AND membership.qualified_at >= ${since.toISOString()}::timestamptz
            AND membership.qualified_at < ${now.toISOString()}::timestamptz
        ))::int AS qualified_from_seed,
        COUNT(DISTINCT source.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM accounts account_record
          WHERE account_record.id = source.account_id
            AND NULLIF(TRIM(account_record.website_url), '') IS NOT NULL
        ))::int AS website_from_seed,
        COUNT(DISTINCT source.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points contact_point
          WHERE contact_point.account_id = source.account_id
            AND contact_point.type = 'email'
            AND NULLIF(TRIM(contact_point.normalized_value), '') IS NOT NULL
        ))::int AS email_found_from_seed,
        COUNT(DISTINCT source.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points contact_point
          WHERE contact_point.account_id = source.account_id
            AND contact_point.type = 'email'
            AND contact_point.verification_status = 'valid'
            AND contact_point.verification_provider = 'millionverifier'
        ))::int AS valid_email_from_seed,
        COUNT(DISTINCT source.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM instantly_lead_imports imported
          WHERE imported.account_id = source.account_id
            AND imported.source_campaign_id = source.campaign_id
            AND imported.status = 'instantly_added'
            AND imported.provider_lead_id IS NOT NULL
            AND imported.uploaded_at IS NOT NULL
            AND imported.uploaded_at >= ${since.toISOString()}::timestamptz
            AND imported.uploaded_at < ${now.toISOString()}::timestamptz
        ))::int AS confirmed_imports_from_seed
      FROM attributable_accounts source
      GROUP BY source.seed_id
    )
    SELECT seed.id AS seed_id, seed.next_eligible_at,
      COALESCE(rollup.recent_runs, 0)::int AS recent_runs,
      COALESCE(rollup.items_returned, 0)::int AS items_returned,
      COALESCE(rollup.new_raw, 0)::int AS new_raw,
      COALESCE(rollup.duplicates, 0)::int AS duplicates,
      COALESCE(rollup.provider_cost_usd, 0)::float AS provider_cost_usd,
      COALESCE(rollup.provider_cost_today_usd, 0)::float AS provider_cost_today_usd,
      COALESCE(coverage.total_raw, 0) > 0
        AND coverage.total_raw = coverage.attributable_raw AS outcome_attribution_complete,
      COALESCE(rollup.items_returned_today, 0)::int AS items_returned_today,
      COALESCE(rollup.new_raw_today, 0)::int AS new_raw_today,
      COALESCE(rollup.duplicates_today, 0)::int AS duplicates_today,
      COALESCE(rollup.zero_novelty_run_streak, 0)::int AS zero_novelty_run_streak,
      rollup.last_run_at,
      CASE WHEN coverage.total_raw > 0 AND coverage.total_raw = coverage.attributable_raw
        THEN COALESCE(outcomes.qualified_from_seed, 0)::int ELSE NULL END AS qualified_from_seed,
      CASE WHEN coverage.total_raw > 0 AND coverage.total_raw = coverage.attributable_raw
        THEN COALESCE(outcomes.website_from_seed, 0)::int ELSE NULL END AS website_from_seed,
      CASE WHEN coverage.total_raw > 0 AND coverage.total_raw = coverage.attributable_raw
        THEN COALESCE(outcomes.email_found_from_seed, 0)::int ELSE NULL END AS email_found_from_seed,
      CASE WHEN coverage.total_raw > 0 AND coverage.total_raw = coverage.attributable_raw
        THEN COALESCE(outcomes.valid_email_from_seed, 0)::int ELSE NULL END AS valid_email_from_seed,
      CASE WHEN coverage.total_raw > 0 AND coverage.total_raw = coverage.attributable_raw
        THEN COALESCE(outcomes.confirmed_imports_from_seed, 0)::int ELSE NULL END AS confirmed_imports_from_seed
    FROM search_seeds seed
    LEFT JOIN run_rollup rollup ON rollup.seed_id = seed.id
    LEFT JOIN outcome_coverage coverage ON coverage.seed_id = seed.id
    LEFT JOIN outcome_rollup outcomes ON outcomes.seed_id = seed.id
    WHERE seed.campaign_id = ${campaignId}::uuid
      AND seed.engine_type = ${engineType}
  `;
}

function economicCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function economicNullableCount(value: unknown): number | null {
  return value === null || value === undefined ? null : economicCount(value);
}

export async function getSeedEconomicPerformance(
  campaignId: string,
  engineType: EngineType,
  now = new Date(),
  timeZone = "Europe/Madrid",
): Promise<Map<string, SeedEconomicPerformance>> {
  if (engineType !== "maps_fast" && engineType !== "maps_deep") return new Map();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayStart = getDayBounds(timeZone, now).start;
  const result = await getDb().execute(buildSeedEconomicPerformanceQuery(campaignId, engineType, since, todayStart, now));
  const performanceBySeed = new Map<string, SeedEconomicPerformance>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const seedId = String(row.seed_id);
    const recentRuns = economicCount(row.recent_runs);
    const itemsReturned = economicCount(row.items_returned);
    const newRaw = economicCount(row.new_raw);
    const providerCostUsd = economicCount(row.provider_cost_usd);
    const qualifiedFromSeed = economicNullableCount(row.qualified_from_seed);
    const websiteFromSeed = economicNullableCount(row.website_from_seed);
    const emailFoundFromSeed = economicNullableCount(row.email_found_from_seed);
    const validEmailFromSeed = economicNullableCount(row.valid_email_from_seed);
    const confirmedInstantlyImportsFromSeed = economicNullableCount(row.confirmed_imports_from_seed);
    const lastRunAt = row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : null;
    performanceBySeed.set(seedId, {
      seedId,
      recentRuns,
      itemsReturned,
      newRaw,
      duplicates: economicCount(row.duplicates),
      noveltyRate: calculateSeedNoveltyRate(newRaw, itemsReturned),
      providerCostUsd,
      providerCostTodayUsd: economicCount(row.provider_cost_today_usd),
      outcomeAttributionComplete: row.outcome_attribution_complete === true,
      itemsReturnedToday: economicCount(row.items_returned_today),
      newRawToday: economicCount(row.new_raw_today),
      duplicatesToday: economicCount(row.duplicates_today),
      costPerNewRaw: newRaw > 0 ? providerCostUsd / newRaw : null,
      qualifiedFromSeed,
      websiteFromSeed,
      emailFoundFromSeed,
      validEmailFromSeed,
      confirmedInstantlyImportsFromSeed,
      qualifiedYield: newRaw > 0 && qualifiedFromSeed !== null ? qualifiedFromSeed / newRaw : null,
      websiteRate: newRaw > 0 && websiteFromSeed !== null ? websiteFromSeed / newRaw : null,
      emailFoundRate: newRaw > 0 && emailFoundFromSeed !== null ? emailFoundFromSeed / newRaw : null,
      validEmailYield: newRaw > 0 && validEmailFromSeed !== null ? validEmailFromSeed / newRaw : null,
      validEmailRate: newRaw > 0 && validEmailFromSeed !== null ? validEmailFromSeed / newRaw : null,
      confirmedImportYield: newRaw > 0 && confirmedInstantlyImportsFromSeed !== null ? confirmedInstantlyImportsFromSeed / newRaw : null,
      instantlyImportRate: newRaw > 0 && confirmedInstantlyImportsFromSeed !== null ? confirmedInstantlyImportsFromSeed / newRaw : null,
      costPerConfirmedImport: confirmedInstantlyImportsFromSeed !== null && confirmedInstantlyImportsFromSeed > 0 ? providerCostUsd / confirmedInstantlyImportsFromSeed : null,
      sampleSize: itemsReturned,
      zeroNoveltyRunStreak: economicCount(row.zero_novelty_run_streak),
      lastRunAt,
      nextEligibleAt: row.next_eligible_at ? new Date(String(row.next_eligible_at)).toISOString() : null,
    });
  }
  return performanceBySeed;
}

export interface ApifyDailyEconomicTotals {
  runs: number;
  itemsRequested: number;
  coreRequestedItems: number;
  explorationRequestedItems: number;
  explorationSeedsRun: number;
  productiveSeedCapacityConstrained: boolean;
  seedTierCounts: Record<"high" | "good" | "marginal" | "low" | "zero" | "exploration", number>;
  spendUsd: number;
  resultsReturned: number;
  accountedResultsReturned: number;
  newRaw: number;
  duplicates: number;
}

export function buildApifyDailyEconomicTotalsQuery(workspaceId: string, since: Date, now: Date) {
  return sql`
    SELECT COUNT(*)::int AS runs,
      COALESCE(SUM(items_requested), 0)::int AS items_requested,
      COALESCE(SUM(NULLIF(metadata->>'seedEconomicCoreRequestedItems', '')::int), 0)::int AS core_requested_items,
      COALESCE(SUM(NULLIF(metadata->>'seedEconomicExplorationRequestedItems', '')::int), 0)::int AS exploration_requested_items,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicExploration' = 'true')::int AS exploration_seeds_run,
      COALESCE(BOOL_OR(metadata->>'productiveSeedCapacityConstrained' = 'true'), false) AS productive_seed_capacity_constrained,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'high')::int AS high_seed_runs,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'good')::int AS good_seed_runs,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'marginal')::int AS marginal_seed_runs,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'low')::int AS low_seed_runs,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'zero')::int AS zero_seed_runs,
      COUNT(*) FILTER (WHERE metadata->>'seedEconomicTier' = 'exploration')::int AS exploration_tier_seed_runs,
      COALESCE(SUM(cost_usd), 0)::float AS spend_usd,
      COALESCE(SUM(items_returned), 0)::int AS results_returned,
      COALESCE(SUM(items_returned) FILTER (WHERE
        NULLIF(metadata #>> '{ingestionAccounting,INSERTED_NEW_RAW}', '') IS NOT NULL
        AND NULLIF(metadata #>> '{ingestionAccounting,DUPLICATE_EXISTING_RAW}', '') IS NOT NULL
      ), 0)::int AS accounted_results_returned,
      COALESCE(SUM(NULLIF(metadata #>> '{ingestionAccounting,INSERTED_NEW_RAW}', '')::int), 0)::int AS new_raw,
      COALESCE(SUM(NULLIF(metadata #>> '{ingestionAccounting,DUPLICATE_EXISTING_RAW}', '')::int), 0)::int AS duplicates
    FROM provider_runs
    WHERE workspace_id = ${workspaceId}::uuid
      AND provider = 'apify'
      AND status <> 'budget_blocked'
      AND started_at >= ${since.toISOString()}::timestamptz
      AND started_at < ${now.toISOString()}::timestamptz
  `;
}

export async function getApifyDailyEconomicTotals(
  workspaceId: string,
  timeZone: string,
  now = new Date(),
): Promise<ApifyDailyEconomicTotals> {
  const { start } = getDayBounds(timeZone, now);
  const result = await getDb().execute(buildApifyDailyEconomicTotalsQuery(workspaceId, start, now));
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return {
    runs: economicCount(row?.runs),
    itemsRequested: economicCount(row?.items_requested),
    coreRequestedItems: economicCount(row?.core_requested_items),
    explorationRequestedItems: economicCount(row?.exploration_requested_items),
    explorationSeedsRun: economicCount(row?.exploration_seeds_run),
    productiveSeedCapacityConstrained: row?.productive_seed_capacity_constrained === true,
    seedTierCounts: {
      high: economicCount(row?.high_seed_runs),
      good: economicCount(row?.good_seed_runs),
      marginal: economicCount(row?.marginal_seed_runs),
      low: economicCount(row?.low_seed_runs),
      zero: economicCount(row?.zero_seed_runs),
      exploration: economicCount(row?.exploration_tier_seed_runs),
    },
    spendUsd: economicCount(row?.spend_usd),
    resultsReturned: economicCount(row?.results_returned),
    accountedResultsReturned: economicCount(row?.accounted_results_returned),
    newRaw: economicCount(row?.new_raw),
    duplicates: economicCount(row?.duplicates),
  };
}

/**
 * Inserts any catalog seed (from `spain-search-catalog.ts`) not already
 * persisted for this campaign+engine, keyed on (query, geography) — the
 * catalog itself is deterministic/idempotent, so this is safe to call on
 * every discovery cron tick without ever duplicating a seed row.
 */
export async function bootstrapSearchSeeds(campaignId: string, engineType: EngineType, catalog: readonly SearchSeed[]): Promise<void> {
  const db = getDb();
  const existing = await listSearchSeedsForCampaignEngine(campaignId, engineType);
  const existingKeys = new Set(existing.map((seed) => `${seed.query}|${seed.geography}`));
  const missing = catalog.filter((seed) => !existingKeys.has(`${seed.query}|${seed.geography}`));
  if (missing.length === 0) return;

  await db.insert(searchSeeds).values(
    missing.map((seed) => ({
      campaignId,
      engineType,
      query: seed.query,
      geography: seed.geography,
    })),
  );
}

export async function updateSearchSeedAfterRun(seed: SearchSeed): Promise<void> {
  const db = getDb();
  await db
    .update(searchSeeds)
    .set({
      lastRunAt: seed.lastRunAt ? new Date(seed.lastRunAt) : null,
      totalRaw: seed.totalRaw,
      totalUnique: seed.totalUnique,
      totalReady: seed.totalReady,
      yieldRate: seed.yieldRate,
      exhaustionScore: seed.exhaustionScore,
      nextEligibleAt: seed.nextEligibleAt ? new Date(seed.nextEligibleAt) : null,
    })
    .where(eq(searchSeeds.id, seed.id));
}

export async function insertSearchSeedRun(run: Omit<SearchSeedRun, "id">): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(searchSeedRuns).values({
    seedId: run.seedId,
    startedAt: new Date(run.startedAt),
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    rawCount: run.rawCount,
    uniqueCount: run.uniqueCount,
    readyCount: run.readyCount,
    error: run.error,
  }).returning({ id: searchSeedRuns.id });
  if (!row) throw new Error("Failed to insert search seed run.");
  return row.id;
}

export async function updateSearchSeedRun(
  id: string,
  patch: Partial<Pick<SearchSeedRun, "finishedAt" | "rawCount" | "uniqueCount" | "readyCount" | "error">>,
): Promise<void> {
  const db = getDb();
  const { finishedAt, ...rest } = patch;
  await db.update(searchSeedRuns).set({
    ...rest,
    finishedAt: finishedAt === undefined ? undefined : finishedAt ? new Date(finishedAt) : null,
  }).where(eq(searchSeedRuns.id, id));
}

export function buildRawSourceFingerprint(externalId: string | null | undefined, sourceUrl: string | null | undefined, fallbackObj: Record<string, unknown>): { fingerprint: string; version: string } {
  if (externalId) return { fingerprint: `place:v1:${externalId.trim()}`, version: "v1" };
  const { normalizeUrl } = require("@/lib/normalization/normalize-url");
  const normalizedUrl = normalizeUrl(sourceUrl);
  if (normalizedUrl) return { fingerprint: `url:v1:${normalizedUrl}`, version: "v1" };
  
  // Try business identity hash if available (name + phone)
  if (fallbackObj && typeof fallbackObj === 'object' && fallbackObj.name) {
    const name = String(fallbackObj.name).toLowerCase().replace(/[^a-z0-9]/g, '');
    const phone = fallbackObj.phone ? String(fallbackObj.phone).replace(/[^0-9]/g, '') : '';
    if (name) {
       const businessHash = require("node:crypto").createHash("sha256").update(`${name}|${phone}`).digest("hex");
       return { fingerprint: `business:v1:${businessHash}`, version: "v1" };
    }
  }

  const jsonStr = JSON.stringify(fallbackObj || {});
  const hash = require("node:crypto").createHash("sha256").update(jsonStr).digest("hex");
  return { fingerprint: `payload:v1:${hash}`, version: "v1" };
}

/** Finalizes the seed run and folds its metrics. (Transaction removed for Neon HTTP compatibility) */
export async function finalizeSearchSeedRun(input: {
  seedRunId: string;
  rawCount: number;
  uniqueCount: number;
  readyCount: number;
  finishedAt: Date;
  error: string | null;
}): Promise<boolean> {
  const db = getDb();
  
  // 1. Mark run finished
  const runResult = await db.execute(sql`
    UPDATE search_seed_runs
    SET finished_at = ${input.finishedAt.toISOString()}::timestamptz,
        raw_count = ${input.rawCount}, unique_count = ${input.uniqueCount},
        ready_count = ${input.readyCount}, error = ${input.error}
    WHERE id = ${input.seedRunId}::uuid AND finished_at IS NULL
    RETURNING seed_id
  `);
  
  if (runResult.rows.length === 0) return false;
  const seedId = runResult.rows[0]?.seed_id as string;

  // 2. Load seed to recompute
  const seedResult = await db.execute(sql`
    SELECT id, campaign_id, engine_type, query, geography, last_run_at,
           total_raw, total_unique, total_ready, yield_rate,
           exhaustion_score, next_eligible_at
    FROM search_seeds
    WHERE id = ${seedId}::uuid
  `);
  const seedRow = seedResult.rows[0] as Record<string, unknown> | undefined;
  if (!seedRow) return true;

  const seed: SearchSeed = {
    id: String(seedRow.id),
    campaignId: String(seedRow.campaign_id),
    engineType: seedRow.engine_type as SearchSeed["engineType"],
    query: String(seedRow.query),
    geography: String(seedRow.geography),
    lastRunAt: seedRow.last_run_at ? new Date(String(seedRow.last_run_at)).toISOString() : null,
    totalRaw: Number(seedRow.total_raw),
    totalUnique: Number(seedRow.total_unique),
    totalReady: Number(seedRow.total_ready),
    yieldRate: Number(seedRow.yield_rate),
    exhaustionScore: Number(seedRow.exhaustion_score),
    nextEligibleAt: seedRow.next_eligible_at ? new Date(String(seedRow.next_eligible_at)).toISOString() : null,
  };

  const updated = recordSeedRun(seed, {
    rawCount: input.rawCount,
    uniqueCount: input.uniqueCount,
    readyCount: input.readyCount,
    finishedAt: input.finishedAt.toISOString(),
  });

  // 3. Update seed
  await db.execute(sql`
    UPDATE search_seeds
    SET last_run_at = ${updated.lastRunAt}::timestamptz,
        total_raw = ${updated.totalRaw}, total_unique = ${updated.totalUnique},
        total_ready = ${updated.totalReady}, yield_rate = ${updated.yieldRate},
        exhaustion_score = ${updated.exhaustionScore},
        next_eligible_at = ${updated.nextEligibleAt}::timestamptz
    WHERE id = ${updated.id}::uuid
  `);
  return true;
}

export interface InsertRawCandidateInput {
  discoveryJobId: string;
  campaignId: string;
  engineType: EngineType;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  sourceFingerprint: string;
  rawPayload: Record<string, unknown>;
  searchSeedRunId?: string | null;
  providerRunId?: string | null;
}

export async function insertRawCandidates(rows: readonly InsertRawCandidateInput[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const inserted = await db
    .insert(rawCandidates)
    .values(rows.map((row) => ({ ...row, processed: false })))
    .onConflictDoNothing()
    .returning({ id: rawCandidates.id });
  return inserted.map((row) => row.id);
}

export async function updateRawCandidateAccountId(rawCandidateId: string, accountId: string): Promise<void> {
  const db = getDb();
  await db.update(rawCandidates).set({ accountId }).where(eq(rawCandidates.id, rawCandidateId));
}

export async function refreshSearchSeedQualification(searchSeedRunId: string): Promise<void> {
  const db = getDb();
  const tx = db;
    const counts = await tx.execute(sql`
      SELECT
        ssr.seed_id,
        count(DISTINCT rc.account_id) FILTER (WHERE cm.account_id IS NOT NULL)::int AS qualified_count,
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM processing_jobs pj
          WHERE pj.payload->>'rawCandidateId' = rc.id::text
            AND pj.status IN ('completed', 'dead_letter')
        ))::int AS pending_count
      FROM search_seed_runs ssr
      LEFT JOIN raw_candidates rc ON rc.search_seed_run_id = ssr.id
      LEFT JOIN campaign_memberships cm ON cm.campaign_id = rc.campaign_id
        AND cm.account_id = rc.account_id AND cm.qualified_at IS NOT NULL
      WHERE ssr.id = ${searchSeedRunId}::uuid
      GROUP BY ssr.seed_id
    `);
    const row = counts.rows[0] as { seed_id: string; qualified_count: number; pending_count: number } | undefined;
    if (!row) return;
    await tx.execute(sql`
      UPDATE search_seed_runs
      SET ready_count = ${Number(row.qualified_count)},
          qualification_finalized_at = CASE WHEN ${Number(row.pending_count)} = 0 THEN COALESCE(qualification_finalized_at, now()) ELSE NULL END
      WHERE id = ${searchSeedRunId}::uuid
    `);
    const finalizedRuns = await tx.execute(sql`
      SELECT ssr.raw_count, ssr.unique_count, ssr.ready_count, ssr.finished_at, ssr.qualification_finalized_at
      FROM search_seed_runs ssr
      WHERE ssr.seed_id = ${row.seed_id}::uuid
        AND ssr.qualification_finalized_at IS NOT NULL
      ORDER BY ssr.finished_at ASC NULLS LAST
    `);
    const seedResult = await tx.execute(sql`
      SELECT id, campaign_id, engine_type, query, geography, last_run_at,
             total_raw, total_unique, total_ready, yield_rate,
             exhaustion_score, next_eligible_at
      FROM search_seeds WHERE id = ${row.seed_id}::uuid FOR UPDATE
    `);
    const seedRow = seedResult.rows[0] as Record<string, unknown> | undefined;
    if (!seedRow) return;
    const seed: SearchSeed = {
      id: String(seedRow.id), campaignId: String(seedRow.campaign_id), engineType: seedRow.engine_type as SearchSeed["engineType"],
      query: String(seedRow.query), geography: String(seedRow.geography),
      lastRunAt: seedRow.last_run_at ? new Date(String(seedRow.last_run_at)).toISOString() : null,
      totalRaw: Number(seedRow.total_raw), totalUnique: Number(seedRow.total_unique), totalReady: Number(seedRow.total_ready),
      yieldRate: Number(seedRow.yield_rate), exhaustionScore: Number(seedRow.exhaustion_score),
      nextEligibleAt: seedRow.next_eligible_at ? new Date(String(seedRow.next_eligible_at)).toISOString() : null,
    };
    const lastRunResult = await tx.execute(sql`
      SELECT MAX(finished_at) as last_run_at
      FROM search_seed_runs
      WHERE seed_id = ${row.seed_id}::uuid
        AND finished_at IS NOT NULL
    `);
    const trueLastRunAt = (lastRunResult.rows[0] as { last_run_at: string | null } | undefined)?.last_run_at ?? null;

    const totals = finalizedRuns.rows.reduce<{ totalRaw: number; totalUnique: number; totalReady: number }>((acc, run) => ({
      totalRaw: acc.totalRaw + Number((run as { raw_count: number }).raw_count),
      totalUnique: acc.totalUnique + Number((run as { unique_count: number }).unique_count),
      totalReady: acc.totalReady + Number((run as { ready_count: number }).ready_count),
    }), { totalRaw: 0, totalUnique: 0, totalReady: 0 });
    const updated = recomputeSeedMetrics(seed, { ...totals, lastRunAt: trueLastRunAt, runCount: finalizedRuns.rows.length });
    await tx.execute(sql`
      UPDATE search_seeds ss
      SET last_run_at = ${updated.lastRunAt}::timestamptz,
          total_raw = ${updated.totalRaw}, total_unique = ${updated.totalUnique}, total_ready = ${updated.totalReady},
          yield_rate = ${updated.yieldRate}, exhaustion_score = ${updated.exhaustionScore},
          next_eligible_at = ${updated.nextEligibleAt}::timestamptz
      WHERE ss.id = ${row.seed_id}::uuid
    `);
}

export async function getRawCandidateById(id: string): Promise<RawCandidate | null> {
  const db = getDb();
  const [row] = await db.select().from(rawCandidates).where(eq(rawCandidates.id, id));
  return row ? toRawCandidate(row) : null;
}

export function buildClaimMapsFastWebsiteRecoveryQuery(rawCandidateId: string) {
  return sql`
    UPDATE raw_candidates
    SET processing_metrics = COALESCE(processing_metrics, '{}'::jsonb)
      || '{"websiteRecoveryStatus":"started","websiteRecoveryProvider":"serper"}'::jsonb
    WHERE id = ${rawCandidateId}::uuid
      AND engine_type = 'maps_fast'
      AND COALESCE(processing_metrics->>'websiteRecoveryStatus', '')
        NOT IN ('started', 'succeeded', 'terminal_no_match', 'failed')
    RETURNING id
  `;
}

export async function claimMapsFastWebsiteRecovery(rawCandidateId: string): Promise<boolean> {
  const db = getDb();
  const claimed = await db.execute(buildClaimMapsFastWebsiteRecoveryQuery(rawCandidateId));
  return claimed.rows.length > 0;
}

export async function updateRawCandidateProcessingMetrics(
  rawCandidateId: string,
  metrics: Partial<CandidateProcessingMetrics>,
): Promise<void> {
  const db = getDb();
  await db.update(rawCandidates).set({
    processingMetrics: sql`COALESCE(${rawCandidates.processingMetrics}, '{}'::jsonb) || ${JSON.stringify(metrics)}::jsonb`,
  }).where(eq(rawCandidates.id, rawCandidateId));
}

export async function markRawCandidateProcessed(id: string, processingMetrics?: CandidateProcessingMetrics): Promise<void> {
  const db = getDb();
  await db.update(rawCandidates).set({
    processed: true,
    ...(processingMetrics ? { processingMetrics } : {}),
  }).where(eq(rawCandidates.id, id));
}

/** Confirms `discoveryJobId` (used by the processing cron to look up the owning campaign/engine without trusting the raw candidate row alone). */
export async function getDiscoveryJobCampaignId(discoveryJobId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select({ campaignId: discoveryJobs.campaignId }).from(discoveryJobs).where(eq(discoveryJobs.id, discoveryJobId));
  return row?.campaignId ?? null;
}

/** Whether `campaignId` already has an in-flight (`pending`/`processing`) discovery job — the per-tick enqueue step uses this to avoid piling up duplicate jobs faster than they can be claimed and drained. */
export async function hasInFlightDiscoveryJob(campaignId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.campaignId, campaignId), inArray(discoveryJobs.status, ["pending", "processing"])))
    .limit(1);
  return Boolean(row);
}

/** Uses qualified Autopilot metrics. */
export async function getRemainingDiscoveryTarget(
  campaignId: string,
  dailySoftTarget: number,
  timeZone = "Europe/Madrid",
  now = new Date(),
): Promise<number> {
  const db = getDb();
  const { start: dayStart, end: dayEnd } = getDayBounds(timeZone, now);
  const progressResult = await db.execute(sql`
    SELECT
      (SELECT COUNT(DISTINCT cm.id)::int
       FROM campaign_memberships cm
       WHERE cm.campaign_id = ${campaignId}::uuid
         AND cm.qualified_at IS NOT NULL
         AND cm.qualified_at >= ${dayStart.toISOString()}::timestamptz
         AND cm.qualified_at < ${dayEnd.toISOString()}::timestamptz
      ) AS generated_today,
      (SELECT COALESCE(SUM(pr.items_requested), 0)::int
       FROM provider_runs pr
       WHERE pr.campaign_id = ${campaignId}::uuid
         AND pr.provider = 'apify'
         AND pr.status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting')
         AND pr.started_at >= ${dayStart.toISOString()}::timestamptz
         AND pr.started_at < ${dayEnd.toISOString()}::timestamptz
      ) AS in_flight_provider_items;
  `);
  const row = progressResult.rows[0] as unknown as { generated_today: number; in_flight_provider_items: number };
  return Math.max(0, dailySoftTarget - Number(row.generated_today ?? 0) - Number(row.in_flight_provider_items ?? 0));
}
