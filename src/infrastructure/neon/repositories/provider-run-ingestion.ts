import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { refreshSearchSeedQualification, type InsertRawCandidateInput } from "./discovery";
import { processingJobIdempotencyKey } from "@/domain/discovery/types";

export interface IngestApifyProviderRunInput {
  providerRunId: string;
  token: string;
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

type Transaction = any;

async function ensureProcessingJob(tx: Transaction, campaignId: string, rawCandidateId: string): Promise<boolean> {
  const key = processingJobIdempotencyKey(rawCandidateId);
  const existing = await tx.execute(sql`
    SELECT id
    FROM processing_jobs
    WHERE idempotency_key = ${key}
    LIMIT 1
  `);
  if (existing.rows[0]) return false;

  const inserted = await tx.execute(sql`
    INSERT INTO processing_jobs (campaign_id, type, payload, idempotency_key)
    VALUES (${campaignId}::uuid, 'process_raw_candidate', ${JSON.stringify({ rawCandidateId })}::jsonb, ${key})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return inserted.rows.length > 0;
}

async function resolveRawCandidate(tx: Transaction, row: InsertRawCandidateInput): Promise<{ id: string; inserted: boolean }> {
  const result = await tx.execute(sql`
    INSERT INTO raw_candidates (
      discovery_job_id, campaign_id, engine_type, source_external_id, source_url, source_fingerprint, raw_payload, search_seed_run_id, provider_run_id
    ) VALUES (
      ${row.discoveryJobId}::uuid, ${row.campaignId}::uuid, ${row.engineType}, ${row.sourceExternalId}, ${row.sourceUrl}, ${row.sourceFingerprint},
      ${JSON.stringify(row.rawPayload)}::jsonb, ${row.searchSeedRunId ?? null}::uuid, ${row.providerRunId ?? null}::uuid
    )
    ON CONFLICT (campaign_id, engine_type, source_fingerprint)
    DO UPDATE SET 
      source_url = EXCLUDED.source_url, 
      raw_payload = EXCLUDED.raw_payload,
      search_seed_run_id = COALESCE(raw_candidates.search_seed_run_id, EXCLUDED.search_seed_run_id),
      provider_run_id = COALESCE(raw_candidates.provider_run_id, EXCLUDED.provider_run_id)
    RETURNING id, (xmax = 0) AS inserted
  `);
  const resolved = result.rows[0] as { id: string; inserted: boolean } | undefined;
  if (!resolved) throw new Error("Unable to resolve raw candidate.");
  return resolved;
}

export async function ingestApifyProviderRun(input: IngestApifyProviderRunInput): Promise<IngestApifyProviderRunResult> {
  const db = getDb();
  const tx = db;
    const locked = await tx.execute(sql`
      SELECT status, ingestion_claim_token
      FROM provider_runs
      WHERE id = ${input.providerRunId}::uuid
    `);
    const providerRun = locked.rows[0] as { status: string, ingestion_claim_token: string | null } | undefined;
    if (!providerRun) throw new Error(`Provider run ${input.providerRunId} was not found.`);
    if (providerRun.status === "ingested") {
      return { rawCandidatesTotal: input.candidates.length, rawCandidatesInserted: 0, processingJobsEnsured: 0, seedMetricsUpdated: false, alreadyIngested: true };
    }
    if (providerRun.status !== "ingesting") {
      throw new Error(`Provider run ${input.providerRunId} is not in ingesting state, got ${providerRun.status}`);
    }
    if (providerRun.ingestion_claim_token !== input.token) {
      throw new Error(`Provider run ${input.providerRunId} ingestion claim token mismatch. Expected ${providerRun.ingestion_claim_token}, got ${input.token}`);
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

    if (input.seedRunId) {
      await tx.execute(sql`
        UPDATE search_seed_runs
        SET finished_at = ${input.finishedAt.toISOString()}::timestamptz,
            raw_count = ${input.candidates.length},
            unique_count = ${resolvedIds.size},
            ready_count = 0,
            qualification_finalized_at = NULL
        WHERE id = ${input.seedRunId}::uuid
      `);
    }

    // Ingested MUST be the final write
    const finalUpdate = await tx.execute(sql`
      UPDATE provider_runs
      SET status = 'ingested', items_returned = ${input.itemsReturned}, cost_usd = ${input.costUsd},
          external_dataset_id = ${input.externalDatasetId},
          ingested_at = ${input.finishedAt.toISOString()}::timestamptz, finished_at = COALESCE(finished_at, ${input.finishedAt.toISOString()}::timestamptz), error = NULL,
          ingestion_claim_token = NULL, ingestion_started_at = NULL
      WHERE id = ${input.providerRunId}::uuid AND ingestion_claim_token = ${input.token} AND status = 'ingesting'
    `);
    
    if (finalUpdate.rowCount !== 1) {
      throw new Error("claim-lost/stale-worker error: unable to finalize provider_run, zero rows affected");
    }
  const result = { rawCandidatesTotal: input.candidates.length, rawCandidatesInserted, processingJobsEnsured, seedMetricsUpdated: false, alreadyIngested: false };
  if (input.seedRunId) await refreshSearchSeedQualification(input.seedRunId);
  return { ...result, seedMetricsUpdated: Boolean(input.seedRunId) };
}