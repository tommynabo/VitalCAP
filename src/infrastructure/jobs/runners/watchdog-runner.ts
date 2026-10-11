import { sql } from "drizzle-orm";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import { evaluateWatchdogPause } from "@/services/autopilot/watchdog-pause-policy";
import { getDb } from "../../neon/db";
import {
  deadLetterExpiredJobs,
  requeueStaleLockedJobs,
  STALE_JOB_LOCK_THRESHOLD_MS,
} from "../../neon/repositories/job-queue";

export interface WatchdogCronResult {
  failedDiscoveryJobs: number;
  failedProcessingJobs: number;
  releasedDiscoveryLocks: number;
  releasedProcessingLocks: number;
  healedProcessingJobs: number;
  stuckProviderRuns: number;
  orphanedSeedRuns: number;
  systemPaused: boolean;
}

export async function runWatchdogCronTick(): Promise<WatchdogCronResult> {
  const db = getDb();

  // 1. Move over-limit jobs to dead_letter (only if lease expired)
  const failedDiscoveryJobs = await deadLetterExpiredJobs("discovery_jobs", STALE_JOB_LOCK_THRESHOLD_MS);
  const failedProcessingJobs = await deadLetterExpiredJobs("processing_jobs", STALE_JOB_LOCK_THRESHOLD_MS);
  const releasedDiscoveryLocks = await requeueStaleLockedJobs("discovery_jobs");
  const releasedProcessingLocks = await requeueStaleLockedJobs("processing_jobs");

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
      finished_at = CASE
        WHEN status = 'starting' AND external_run_id IS NULL THEN COALESCE(finished_at, NOW())
        ELSE finished_at
      END,
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
  const healthRows = await db.execute(sql`
    WITH workspace_health AS (
      SELECT
        w.id AS workspace_id,
        (SELECT count(*) FROM discovery_jobs dj JOIN campaigns c ON dj.campaign_id = c.id
          WHERE c.workspace_id = w.id AND dj.status = 'pending'
            AND (dj.next_attempt_at IS NULL OR dj.next_attempt_at <= NOW())
            AND LEFT(COALESCE(dj.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) <> ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}
            AND dj.created_at < NOW() - INTERVAL '30 minutes')::int AS old_due_discovery,
        (SELECT count(*) FROM discovery_jobs dj JOIN campaigns c ON dj.campaign_id = c.id
          WHERE c.workspace_id = w.id AND dj.status = 'pending'
            AND (dj.next_attempt_at > NOW() OR LEFT(COALESCE(dj.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) = ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}))::int AS deferred_discovery,
        (SELECT count(*) FROM processing_jobs pj JOIN campaigns c ON pj.campaign_id = c.id
          WHERE c.workspace_id = w.id AND pj.status = 'pending'
            AND (pj.next_attempt_at IS NULL OR pj.next_attempt_at <= NOW())
            AND pj.created_at < NOW() - INTERVAL '30 minutes')::int AS old_processing,
        (SELECT count(*) FROM discovery_jobs dj JOIN campaigns c ON dj.campaign_id = c.id
          WHERE c.workspace_id = w.id AND dj.status = 'processing'
            AND dj.locked_at < NOW() - (${STALE_JOB_LOCK_THRESHOLD_MS / 60_000} * INTERVAL '1 minute'))::int AS stuck_discovery,
        (SELECT count(*) FROM processing_jobs pj JOIN campaigns c ON pj.campaign_id = c.id
          WHERE c.workspace_id = w.id AND pj.status = 'processing'
            AND pj.locked_at < NOW() - (${STALE_JOB_LOCK_THRESHOLD_MS / 60_000} * INTERVAL '1 minute'))::int AS stuck_processing,
        (SELECT count(*) FROM provider_runs pr
          WHERE pr.workspace_id = w.id AND pr.status = 'manual_reconciliation_required')::int AS provider_reconciliations
      FROM workspaces w
    )
    SELECT wh.*, aps.system_paused, aps.system_pause_reason, aps.system_paused_at
    FROM workspace_health wh
    JOIN autopilot_settings aps ON aps.workspace_id = wh.workspace_id AND aps.enabled = true
  `);

  for (const row of healthRows.rows as Array<Record<string, unknown>>) {
    const current = {
      systemPaused: row.system_paused === true,
      systemPauseReason: typeof row.system_pause_reason === "string" ? row.system_pause_reason : null,
      systemPausedAt: row.system_paused_at ? new Date(String(row.system_paused_at)) : null,
    };
    const decision = evaluateWatchdogPause(current, {
      oldDueDiscovery: Number(row.old_due_discovery ?? 0),
      deferredDiscovery: Number(row.deferred_discovery ?? 0),
      oldProcessing: Number(row.old_processing ?? 0),
      staleDiscoveryLocks: Number(row.stuck_discovery ?? 0),
      staleProcessingLocks: Number(row.stuck_processing ?? 0),
      manualReconciliations: Number(row.provider_reconciliations ?? 0),
    }, new Date());

    if (decision.systemPaused !== current.systemPaused
      || decision.systemPauseReason !== current.systemPauseReason
      || decision.systemPausedAt?.getTime() !== current.systemPausedAt?.getTime()) {
      await db.execute(sql`
        UPDATE autopilot_settings
        SET system_paused = ${decision.systemPaused},
            system_pause_reason = ${decision.systemPauseReason},
            system_paused_at = ${decision.systemPausedAt?.toISOString() ?? null}::timestamptz
        WHERE workspace_id = ${String(row.workspace_id)}::uuid AND enabled = true
      `);
    }
  }

  const pausedCount = await db.execute(sql`SELECT count(*) FROM autopilot_settings WHERE system_paused = true`);
  const systemPaused = Number(pausedCount.rows[0]?.count) > 0;

  return { failedDiscoveryJobs, failedProcessingJobs, releasedDiscoveryLocks, releasedProcessingLocks, healedProcessingJobs, stuckProviderRuns, orphanedSeedRuns, systemPaused };
}
