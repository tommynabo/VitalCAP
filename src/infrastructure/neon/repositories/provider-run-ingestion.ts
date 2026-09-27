import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { refreshSearchSeedQualification, type InsertRawCandidateInput } from "./discovery";

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
      INSERT INTO raw_candidates (discovery_job_id, campaign_id, engine_type, source_external_id, source_url, raw_payload, search_seed_run_id, provider_run_id)
      VALUES (${row.discoveryJobId}::uuid, ${row.campaignId}::uuid, ${row.engineType}, ${row.sourceExternalId}, ${row.sourceUrl}, ${JSON.stringify(row.rawPayload)}::jsonb,
        ${row.searchSeedRunId ?? null}::uuid, ${row.providerRunId ?? null}::uuid)
      ON CONFLICT (campaign_id, engine_type, source_external_id)
      WHERE source_external_id IS NOT NULL
      DO UPDATE SET source_url = EXCLUDED.source_url, raw_payload = EXCLUDED.raw_payload,
        search_seed_run_id = COALESCE(raw_candidates.search_seed_run_id, EXCLUDED.search_seed_run_id),
        provider_run_id = COALESCE(raw_candidates.provider_run_id, EXCLUDED.provider_run_id)
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
      INSERT INTO raw_candidates (discovery_job_id, campaign_id, engine_type, source_external_id, source_url, raw_payload, search_seed_run_id, provider_run_id)
      VALUES (${row.discoveryJobId}::uuid, ${row.campaignId}::uuid, ${row.engineType}, NULL, ${row.sourceUrl}, ${JSON.stringify(row.rawPayload)}::jsonb,
        ${row.searchSeedRunId ?? null}::uuid, ${row.providerRunId ?? null}::uuid)
    RETURNING id
  `);
  const insertedRow = inserted.rows[0] as { id: string } | undefined;
  if (!insertedRow) throw new Error("Unable to insert raw candidate.");
  return { id: insertedRow.id, inserted: true };
}

export async function ingestApifyProviderRun(input: IngestApifyProviderRunInput): Promise<IngestApifyProviderRunResult> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
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

    await tx.execute(sql`
      UPDATE provider_runs
      SET status = 'ingested', items_returned = ${input.itemsReturned}, cost_usd = ${input.costUsd},
          external_dataset_id = ${input.externalDatasetId},
          ingested_at = ${input.finishedAt.toISOString()}::timestamptz, finished_at = COALESCE(finished_at, ${input.finishedAt.toISOString()}::timestamptz), error = NULL
      WHERE id = ${input.providerRunId}::uuid
    `);
    return { rawCandidatesTotal: input.candidates.length, rawCandidatesInserted, processingJobsEnsured, seedMetricsUpdated: false, alreadyIngested: false };
  });
  if (input.seedRunId) await refreshSearchSeedQualification(input.seedRunId);
  return { ...result, seedMetricsUpdated: Boolean(input.seedRunId) };
}