import { sql } from "drizzle-orm";
import { getDb } from "../db";
import type { InsertRawCandidateInput } from "./discovery";
import { recordSeedRun } from "@/services/discovery/geography-planner";
import type { SearchSeed } from "@/domain/discovery/types";

export interface IngestApifyProviderRunInput {
  providerRunId: string;
  campaignId: string;
  discoveryJobId: string;
  seedRunId: string | null;
  externalDatasetId: string;
  candidates: readonly InsertRawCandidateInput[];
  finishedAt: Date;
  costUsd: number;
  itemsReturned: number;
}

export interface IngestApifyProviderRunResult {
  rawCandidatesTotal: number;
  rawCandidatesInserted: number;
  processingJobsEnsured: number;
  seedMetricsUpdated: boolean;
  alreadyIngested: boolean;
}

interface SeedRow {
  id: string;
  campaign_id: string;
  engine_type: SearchSeed["engineType"];
  query: string;
  geography: string;
  last_run_at: string | null;
  total_raw: number;
  total_unique: number;
  total_ready: number;
  yield_rate: number;
  exhaustion_score: number;
  next_eligible_at: string | null;
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function ensureProcessingJob(tx: Transaction, campaignId: string, rawCandidateId: string): Promise<boolean> {
  const existing = await tx.execute(sql`
    SELECT id
    FROM processing_jobs
    WHERE idempotency_key = ${`raw_candidate:${rawCandidateId}`}
    LIMIT 1
  `);
  if (existing.rows[0]) return false;

  const inserted = await tx.execute(sql`
    INSERT INTO processing_jobs (campaign_id, type, payload, idempotency_key)
    VALUES (${campaignId}::uuid, 'process_raw_candidate', ${JSON.stringify({ rawCandidateId })}::jsonb, ${`raw_candidate:${rawCandidateId}`})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return inserted.rows.length > 0;
}

async function resolveRawCandidate(tx: Transaction, row: InsertRawCandidateInput): Promise<{ id: string; inserted: boolean }> {
  if (row.sourceExternalId) {
    const result = await tx.execute(sql`
      INSERT INTO raw_candidates (discovery_job_id, campaign_id, engine_type, source_external_id, source_url, raw_payload)
      VALUES (${row.discoveryJobId}::uuid, ${row.campaignId}::uuid, ${row.engineType}, ${row.sourceExternalId}, ${row.sourceUrl}, ${JSON.stringify(row.rawPayload)}::jsonb)
      ON CONFLICT (campaign_id, engine_type, source_external_id)
      WHERE source_external_id IS NOT NULL
      DO UPDATE SET source_url = EXCLUDED.source_url, raw_payload = EXCLUDED.raw_payload
      RETURNING id, (xmax = 0) AS inserted
    `);
    const resolved = result.rows[0] as { id: string; inserted: boolean } | undefined;
    if (!resolved) throw new Error("Unable to resolve raw candidate.");
    return resolved;
  }

  const existing = await tx.execute(sql`
    SELECT id
    FROM raw_candidates
    WHERE campaign_id = ${row.campaignId}::uuid
      AND engine_type = ${row.engineType}
      AND source_external_id IS NULL
      AND source_url IS NOT DISTINCT FROM ${row.sourceUrl}
    ORDER BY discovered_at ASC
    LIMIT 1
    FOR UPDATE
  `);
  const existingRow = existing.rows[0] as { id: string } | undefined;
  if (existingRow) return { id: existingRow.id, inserted: false };

  const inserted = await tx.execute(sql`
    INSERT INTO raw_candidates (discovery_job_id, campaign_id, engine_type, source_external_id, source_url, raw_payload)
    VALUES (${row.discoveryJobId}::uuid, ${row.campaignId}::uuid, ${row.engineType}, NULL, ${row.sourceUrl}, ${JSON.stringify(row.rawPayload)}::jsonb)
    RETURNING id
  `);
  const insertedRow = inserted.rows[0] as { id: string } | undefined;
  if (!insertedRow) throw new Error("Unable to insert raw candidate.");
  return { id: insertedRow.id, inserted: true };
}

async function finalizeSeedRun(tx: Transaction, seedRunId: string, finishedAt: Date, rawCount: number, uniqueCount: number): Promise<boolean> {
  const runResult = await tx.execute(sql`
    SELECT id, seed_id, finished_at
    FROM search_seed_runs
    WHERE id = ${seedRunId}::uuid
    FOR UPDATE
  `);
  const run = runResult.rows[0] as { seed_id: string; finished_at: string | null } | undefined;
  if (!run) throw new Error(`Search seed run ${seedRunId} was not found.`);
  if (run.finished_at) return false;

  const seedResult = await tx.execute(sql`
    SELECT id, campaign_id, engine_type, query, geography, last_run_at,
           total_raw, total_unique, total_ready, yield_rate,
           exhaustion_score, next_eligible_at
    FROM search_seeds
    WHERE id = ${run.seed_id}::uuid
    FOR UPDATE
  `);
  const seedRow = seedResult.rows[0] as SeedRow | undefined;
  if (!seedRow) throw new Error(`Search seed ${run.seed_id} was not found.`);
  const seed: SearchSeed = {
    id: seedRow.id,
    campaignId: seedRow.campaign_id,
    engineType: seedRow.engine_type,
    query: seedRow.query,
    geography: seedRow.geography,
    lastRunAt: seedRow.last_run_at ? new Date(seedRow.last_run_at).toISOString() : null,
    totalRaw: Number(seedRow.total_raw),
    totalUnique: Number(seedRow.total_unique),
    totalReady: Number(seedRow.total_ready),
    yieldRate: Number(seedRow.yield_rate),
    exhaustionScore: Number(seedRow.exhaustion_score),
    nextEligibleAt: seedRow.next_eligible_at ? new Date(seedRow.next_eligible_at).toISOString() : null,
  };
  const updated = recordSeedRun(seed, { rawCount, uniqueCount, readyCount: 0, finishedAt: finishedAt.toISOString() });
  await tx.execute(sql`
    UPDATE search_seed_runs
    SET finished_at = ${finishedAt.toISOString()}::timestamptz,
        raw_count = ${rawCount}, unique_count = ${uniqueCount}, ready_count = 0, error = NULL
    WHERE id = ${seedRunId}::uuid
  `);
  await tx.execute(sql`
    UPDATE search_seeds
    SET last_run_at = ${updated.lastRunAt}::timestamptz,
        total_raw = ${updated.totalRaw}, total_unique = ${updated.totalUnique},
        total_ready = ${updated.totalReady}, yield_rate = ${updated.yieldRate},
        exhaustion_score = ${updated.exhaustionScore}, next_eligible_at = ${updated.nextEligibleAt}::timestamptz
    WHERE id = ${updated.id}::uuid
  `);
  return true;
}

export async function ingestApifyProviderRun(input: IngestApifyProviderRunInput): Promise<IngestApifyProviderRunResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT status
      FROM provider_runs
      WHERE id = ${input.providerRunId}::uuid
      FOR UPDATE
    `);
    const providerRun = locked.rows[0] as { status: string } | undefined;
    if (!providerRun) throw new Error(`Provider run ${input.providerRunId} was not found.`);
    if (providerRun.status === "ingested") {
      return { rawCandidatesTotal: input.candidates.length, rawCandidatesInserted: 0, processingJobsEnsured: 0, seedMetricsUpdated: false, alreadyIngested: true };
    }

    const resolvedIds = new Set<string>();
    let rawCandidatesInserted = 0;
    let processingJobsEnsured = 0;
    for (const candidate of input.candidates) {
      const resolved = await resolveRawCandidate(tx, candidate);
      resolvedIds.add(resolved.id);
      if (resolved.inserted) rawCandidatesInserted += 1;
    }
    for (const rawCandidateId of resolvedIds) {
      if (await ensureProcessingJob(tx, input.campaignId, rawCandidateId)) processingJobsEnsured += 1;
    }

    const seedMetricsUpdated = input.seedRunId
      ? await finalizeSeedRun(tx, input.seedRunId, input.finishedAt, input.candidates.length, resolvedIds.size)
      : false;
    await tx.execute(sql`
      UPDATE provider_runs
      SET status = 'ingested', items_returned = ${input.itemsReturned}, cost_usd = ${input.costUsd},
          external_dataset_id = ${input.externalDatasetId},
          ingested_at = ${input.finishedAt.toISOString()}::timestamptz, finished_at = COALESCE(finished_at, ${input.finishedAt.toISOString()}::timestamptz), error = NULL
      WHERE id = ${input.providerRunId}::uuid
    `);
    return { rawCandidatesTotal: input.candidates.length, rawCandidatesInserted, processingJobsEnsured, seedMetricsUpdated, alreadyIngested: false };
  });
}