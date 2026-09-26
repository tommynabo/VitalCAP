import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { searchSeeds, searchSeedRuns, discoveryJobs, rawCandidates } from "../schema/discovery";
import { campaigns } from "../schema/campaigns";
import type { EngineType } from "@/domain/campaigns/types";
import type { RawCandidate, SearchSeed, SearchSeedRun } from "@/domain/discovery/types";
import { getDayBounds } from "@/lib/time/day-bounds";

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
      (SELECT COUNT(*)::int
       FROM processing_jobs pj
       WHERE pj.campaign_id = ${campaignId}::uuid
         AND pj.status IN ('pending', 'processing')
         AND NOT EXISTS (
           SELECT 1
           FROM raw_candidates rc
           WHERE rc.id::text = pj.payload ->> 'rawCandidateId'
         )) AS in_flight;
  `);
  const row = progressResult.rows[0] as unknown as { generated_today: number; in_flight: number };
  return Math.max(0, dailySoftTarget - Number(row.generated_today ?? 0) - Number(row.in_flight ?? 0));
}
