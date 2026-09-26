import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { searchSeeds, searchSeedRuns, discoveryJobs, rawCandidates } from "../schema/discovery";
import { campaigns } from "../schema/campaigns";
import type { EngineType } from "@/domain/campaigns/types";
import type { RawCandidate, SearchSeed, SearchSeedRun } from "@/domain/discovery/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { recordSeedRun } from "@/services/discovery/geography-planner";

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

/** Finalizes the seed run and folds its metrics exactly once in one DB transaction. */
export async function finalizeSearchSeedRun(input: {
  seedRunId: string;
  rawCount: number;
  uniqueCount: number;
  readyCount: number;
  finishedAt: Date;
  error: string | null;
}): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const runResult = await tx.execute(sql`
      SELECT id, seed_id, finished_at
      FROM search_seed_runs
      WHERE id = ${input.seedRunId}::uuid
      FOR UPDATE
    `);
    const run = runResult.rows[0] as { id: string; seed_id: string; finished_at: string | null } | undefined;
    if (!run) throw new Error(`Search seed run ${input.seedRunId} was not found.`);
    if (run.finished_at) return false;

    const seedResult = await tx.execute(sql`
      SELECT id, campaign_id, engine_type, query, geography, last_run_at,
             total_raw, total_unique, total_ready, yield_rate,
             exhaustion_score, next_eligible_at
      FROM search_seeds
      WHERE id = ${run.seed_id}::uuid
      FOR UPDATE
    `);
    const seedRow = seedResult.rows[0] as Record<string, unknown> | undefined;
    if (!seedRow) throw new Error(`Search seed ${run.seed_id} was not found.`);
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
    await tx.execute(sql`
      UPDATE search_seed_runs
      SET finished_at = ${input.finishedAt.toISOString()}::timestamptz,
          raw_count = ${input.rawCount}, unique_count = ${input.uniqueCount},
          ready_count = ${input.readyCount}, error = ${input.error}
      WHERE id = ${input.seedRunId}::uuid
    `);
    await tx.execute(sql`
      UPDATE search_seeds
      SET last_run_at = ${updated.lastRunAt}::timestamptz,
          total_raw = ${updated.totalRaw}, total_unique = ${updated.totalUnique},
          total_ready = ${updated.totalReady}, yield_rate = ${updated.yieldRate},
          exhaustion_score = ${updated.exhaustionScore},
          next_eligible_at = ${updated.nextEligibleAt}::timestamptz
      WHERE id = ${updated.id}::uuid
    `);
    return true;
  });
}

export interface InsertRawCandidateInput {
  discoveryJobId: string;
  campaignId: string;
  engineType: EngineType;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  rawPayload: Record<string, unknown>;
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

export async function getRawCandidateById(id: string): Promise<RawCandidate | null> {
  const db = getDb();
  const [row] = await db.select().from(rawCandidates).where(eq(rawCandidates.id, id));
  return row ? toRawCandidate(row) : null;
}

export async function markRawCandidateProcessed(id: string): Promise<void> {
  const db = getDb();
  await db.update(rawCandidates).set({ processed: true }).where(eq(rawCandidates.id, id));
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

/** Temporary discovery-level budget until qualified Autopilot metrics replace it. */
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
      (SELECT COUNT(DISTINCT rc.id)::int
       FROM raw_candidates rc
       WHERE rc.campaign_id = ${campaignId}::uuid
         AND rc.discovered_at >= ${dayStart.toISOString()}::timestamptz
         AND rc.discovered_at < ${dayEnd.toISOString()}::timestamptz
      ) AS generated_today,
      (SELECT COALESCE(SUM(pr.items_requested), 0)::int
       FROM provider_runs pr
       WHERE pr.campaign_id = ${campaignId}::uuid
         AND pr.provider = 'apify'
         AND pr.status IN ('starting', 'queued', 'running')
         AND pr.started_at >= ${dayStart.toISOString()}::timestamptz
         AND pr.started_at < ${dayEnd.toISOString()}::timestamptz
      ) AS in_flight_provider_items;
  `);
  const row = progressResult.rows[0] as unknown as { generated_today: number; in_flight_provider_items: number };
  return Math.max(0, dailySoftTarget - Number(row.generated_today ?? 0) - Number(row.in_flight_provider_items ?? 0));
}
