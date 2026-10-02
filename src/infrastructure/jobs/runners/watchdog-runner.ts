import { sql } from "drizzle-orm";
import { getDb } from "../../neon/db";
import { deadLetterExpiredJobs } from "../../neon/repositories/job-queue";

export interface WatchdogCronResult {
  failedDiscoveryJobs: number;
  failedProcessingJobs: number;
  healedProcessingJobs: number;
  stuckProviderRuns: number;
  orphanedSeedRuns: number;
  systemPaused: boolean;
}

export async function runWatchdogCronTick(): Promise<WatchdogCronResult> {
  const db = getDb();

  // 1. Move over-limit jobs to dead_letter (only if lease expired)
  const failedDiscoveryJobs = await deadLetterExpiredJobs("discovery_jobs");
  const failedProcessingJobs = await deadLetterExpiredJobs("processing_jobs");

  // 2. Self-Heal missing processing job
  const healedProcessing = await db.execute(sql`
    WITH missing AS (
      SELECT r.id, r.campaign_id, r.discovery_job_id
      FROM raw_candidates r
      LEFT JOIN processing_jobs pj ON pj.idempotency_key = 'raw_candidate:' || r.id::text OR pj.payload->>'rawCandidateId' = r.id::text
      WHERE r.processed = false AND pj.id IS NULL
    )
    INSERT INTO processing_jobs (campaign_id, type, payload, idempotency_key)
    SELECT 
      missing.campaign_id::uuid, 
      'process_raw_candidate', 
      jsonb_build_object('rawCandidateId', missing.id::text, 'discoveryJobId', missing.discovery_job_id::text), 
      'raw_candidate:' || missing.id::text
    FROM missing
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const healedProcessingJobs = healedProcessing.rows.length;

  // 3. Old startup failures were historically escalated to manual
  // reconciliation. A missing external ID is a known, retryable startup
  // failure, so recover it without deleting the original audit/error data.
  await db.execute(sql`
    UPDATE provider_runs
    SET status = 'failed', finished_at = COALESCE(finished_at, NOW()),
        error = COALESCE(error || ' | ', '') || 'Recovered known startup failure (watchdog)'
    WHERE status = 'manual_reconciliation_required'
      AND external_run_id IS NULL
  `);

  // 4. Provider Runs Watchdog
  const providerRunsHeal = await db.execute(sql`
    UPDATE provider_runs 
    SET 
      status = CASE 
        WHEN status = 'starting' AND external_run_id IS NULL THEN 'failed'
        WHEN status = 'succeeded' THEN 'succeeded'
        WHEN status = 'ingesting' AND ingestion_attempt_count >= 5 THEN 'failed'
        WHEN status = 'ingesting' AND ingestion_attempt_count < 5 THEN 'succeeded'
        ELSE status
      END,
      ingestion_claim_token = CASE
        WHEN status = 'ingesting' AND ingestion_attempt_count < 5 THEN NULL
        ELSE ingestion_claim_token
      END,
      ingestion_started_at = CASE
        WHEN status = 'ingesting' AND ingestion_attempt_count < 5 THEN NULL
        ELSE ingestion_started_at
      END,
      error = CASE 
        WHEN status = 'starting' AND external_run_id IS NULL THEN 'Provider startup failed without external ID (watchdog recovery)'
        WHEN status = 'succeeded' THEN 'Max ingestion attempts exceeded (watchdog)'
        WHEN status = 'ingesting' AND ingestion_attempt_count >= 5 THEN 'Max ingestion attempts exceeded (watchdog recovery)'
        WHEN status = 'ingesting' AND ingestion_attempt_count < 5 THEN 'Stale ingestion lease (watchdog)'
        ELSE error
      END
    WHERE 
      (status = 'starting' AND external_run_id IS NULL AND started_at < NOW() - INTERVAL '15 minutes')
      OR
      (status = 'succeeded' AND ingested_at IS NULL AND finished_at < NOW() - INTERVAL '1 hour' AND ingestion_attempt_count >= 5)
      OR
      (status = 'ingesting' AND ingestion_started_at < NOW() - INTERVAL '15 minutes')
    RETURNING id
  `);
  const stuckProviderRuns = providerRunsHeal.rows.length;

  // 5. Provider terminal states -> search seed run
  const orphanedSeeds = await db.execute(sql`
    UPDATE search_seed_runs ssr
    SET finished_at = NOW(), error = 'Closed via watchdog due to provider run terminal state'
    FROM provider_runs pr
    WHERE ssr.finished_at IS NULL 
      AND pr.seed_run_id = ssr.id
      AND pr.status IN ('failed', 'aborted', 'timed_out', 'manual_reconciliation_required')
    RETURNING ssr.id
  `);
  const orphanedSeedRuns = orphanedSeeds.rows.length;

  // 6. Autopilot System Pause Check (Queue Health) - Workspace Scoped
  await db.execute(sql`
    WITH workspace_health AS (
      SELECT 
        w.id as workspace_id,
        (SELECT count(*) FROM discovery_jobs dj JOIN campaigns c ON dj.campaign_id = c.id WHERE c.workspace_id = w.id AND dj.status = 'pending' AND (dj.next_attempt_at IS NULL OR dj.next_attempt_at <= NOW()) AND dj.created_at < NOW() - INTERVAL '30 minutes')::int as old_discovery,
        (SELECT count(*) FROM processing_jobs pj JOIN campaigns c ON pj.campaign_id = c.id WHERE c.workspace_id = w.id AND pj.status = 'pending' AND (pj.next_attempt_at IS NULL OR pj.next_attempt_at <= NOW()) AND pj.created_at < NOW() - INTERVAL '30 minutes')::int as old_processing,
        (SELECT count(*) FROM discovery_jobs dj JOIN campaigns c ON dj.campaign_id = c.id WHERE c.workspace_id = w.id AND dj.status = 'processing' AND dj.locked_at < NOW() - INTERVAL '10 minutes')::int as stuck_discovery,
        (SELECT count(*) FROM processing_jobs pj JOIN campaigns c ON pj.campaign_id = c.id WHERE c.workspace_id = w.id AND pj.status = 'processing' AND pj.locked_at < NOW() - INTERVAL '10 minutes')::int as stuck_processing,
        (SELECT count(*) FROM provider_runs pr WHERE pr.workspace_id = w.id AND pr.status = 'manual_reconciliation_required')::int as provider_reconciliations
      FROM workspaces w
    )
    UPDATE autopilot_settings aps
    SET 
      system_paused = CASE 
        WHEN aps.system_paused = true AND aps.system_pause_reason NOT IN ('Queue health deteriorated (watchdog)', 'provider_reconciliation') THEN true
        WHEN wh.provider_reconciliations > 0 THEN true
        WHEN (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) THEN true 
        ELSE false 
      END,
      system_pause_reason = CASE 
        WHEN aps.system_paused = true AND aps.system_pause_reason NOT IN ('Queue health deteriorated (watchdog)', 'provider_reconciliation') THEN aps.system_pause_reason
        WHEN wh.provider_reconciliations > 0 THEN 'provider_reconciliation'
        WHEN (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) THEN 'Queue health deteriorated (watchdog)' 
        ELSE NULL 
      END,
      system_paused_at = CASE 
        WHEN aps.system_paused = true AND aps.system_pause_reason NOT IN ('Queue health deteriorated (watchdog)', 'provider_reconciliation') THEN aps.system_paused_at
        WHEN wh.provider_reconciliations > 0 AND aps.system_paused = false THEN NOW()
        WHEN (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) AND aps.system_paused = false THEN NOW()
        WHEN wh.provider_reconciliations = 0 AND NOT (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) THEN NULL
        ELSE aps.system_paused_at
      END
    FROM workspace_health wh
    WHERE aps.workspace_id = wh.workspace_id
      AND aps.enabled = true
      AND (
        aps.system_paused != CASE 
          WHEN aps.system_paused = true AND aps.system_pause_reason NOT IN ('Queue health deteriorated (watchdog)', 'provider_reconciliation') THEN true
          WHEN wh.provider_reconciliations > 0 THEN true 
          WHEN (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) THEN true 
          ELSE false 
        END
        OR (aps.system_paused = true AND aps.system_pause_reason != CASE 
          WHEN aps.system_paused = true AND aps.system_pause_reason NOT IN ('Queue health deteriorated (watchdog)', 'provider_reconciliation') THEN aps.system_pause_reason
          WHEN wh.provider_reconciliations > 0 THEN 'provider_reconciliation' 
          WHEN (wh.old_discovery > 0 OR wh.old_processing > 0 OR wh.stuck_discovery > 0 OR wh.stuck_processing > 0) THEN 'Queue health deteriorated (watchdog)'
          ELSE NULL 
        END)
      )
  `);

  const pausedCount = await db.execute(sql`SELECT count(*) FROM autopilot_settings WHERE system_paused = true`);
  const systemPaused = Number(pausedCount.rows[0]?.count) > 0;

  return { failedDiscoveryJobs, failedProcessingJobs, healedProcessingJobs, stuckProviderRuns, orphanedSeedRuns, systemPaused };
}
