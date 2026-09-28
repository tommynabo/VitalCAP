import { sql } from "drizzle-orm";
import { getDb } from "../../neon/db";

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
  let failedDiscoveryJobs = 0;
  let failedProcessingJobs = 0;
  let healedProcessingJobs = 0;
  let stuckProviderRuns = 0;
  let orphanedSeedRuns = 0;

  // 1. Move over-limit jobs to dead_letter
  const overLimitDiscovery = await db.execute(sql`
    SELECT id, campaign_id, payload, attempt_count 
    FROM discovery_jobs 
    WHERE attempt_count >= max_attempts AND status IN ('pending', 'processing')
  `);
  
  for (const row of overLimitDiscovery.rows) {
    await db.execute(sql`UPDATE discovery_jobs SET status = 'dead_letter', locked_at = NULL, locked_by = NULL WHERE id = ${row.id}::uuid`);
    await db.execute(sql`
      INSERT INTO dead_letter_jobs (source_table, source_job_id, campaign_id, payload, attempt_count, last_error)
      VALUES ('discovery_jobs', ${row.id}::uuid, ${row.campaign_id}::uuid, ${row.payload}::jsonb, ${row.attempt_count}, 'Max attempts exceeded via watchdog')
      ON CONFLICT DO NOTHING
    `);
    failedDiscoveryJobs++;
  }

  const overLimitProcessing = await db.execute(sql`
    SELECT id, campaign_id, payload, attempt_count 
    FROM processing_jobs 
    WHERE attempt_count >= max_attempts AND status IN ('pending', 'processing')
  `);

  for (const row of overLimitProcessing.rows) {
    await db.execute(sql`UPDATE processing_jobs SET status = 'dead_letter', locked_at = NULL, locked_by = NULL WHERE id = ${row.id}::uuid`);
    await db.execute(sql`
      INSERT INTO dead_letter_jobs (source_table, source_job_id, campaign_id, payload, attempt_count, last_error)
      VALUES ('processing_jobs', ${row.id}::uuid, ${row.campaign_id}::uuid, ${row.payload}::jsonb, ${row.attempt_count}, 'Max attempts exceeded via watchdog')
      ON CONFLICT DO NOTHING
    `);
    failedProcessingJobs++;
  }

  // 2. Self-Heal missing processing job
  const missingProcessing = await db.execute(sql`
    SELECT r.id, r.campaign_id, r.discovery_job_id
    FROM raw_candidates r
    LEFT JOIN processing_jobs pj ON pj.idempotency_key = 'process_raw_' || r.id::text
    WHERE r.processed = false AND pj.id IS NULL
  `);

  for (const row of missingProcessing.rows) {
    await db.execute(sql`
      INSERT INTO processing_jobs (campaign_id, type, payload, idempotency_key)
      VALUES (
        ${row.campaign_id}::uuid, 
        'process_raw_candidate', 
        jsonb_build_object('rawCandidateId', ${row.id}::text, 'discoveryJobId', ${row.discovery_job_id}::text), 
        'process_raw_' || ${row.id}::text
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing') DO NOTHING
    `);
    healedProcessingJobs++;
  }

  // 3. Provider Runs Watchdog
  const providerRunsHeal = await db.execute(sql`
    UPDATE provider_runs 
    SET 
      status = CASE 
        WHEN status = 'starting' AND external_run_id IS NULL THEN 'manual_reconciliation_required'
        WHEN status = 'running' THEN 'timed_out'
        WHEN status = 'succeeded' THEN 'manual_reconciliation_required'
        ELSE status
      END,
      error = CASE 
        WHEN status = 'starting' AND external_run_id IS NULL THEN 'Stuck in starting without external ID (watchdog)'
        WHEN status = 'running' THEN 'Provider run timed out (watchdog)'
        WHEN status = 'succeeded' THEN 'Succeeded but never ingested (watchdog)'
        ELSE error
      END,
      finished_at = CASE WHEN status = 'running' THEN NOW() ELSE finished_at END
    WHERE 
      (status = 'starting' AND external_run_id IS NULL AND started_at < NOW() - INTERVAL '15 minutes')
      OR
      (status = 'running' AND started_at < NOW() - INTERVAL '2 hours')
      OR
      (status = 'succeeded' AND ingested_at IS NULL AND finished_at < NOW() - INTERVAL '1 hour')
    RETURNING id
  `);
  stuckProviderRuns = providerRunsHeal.rows.length;

  // 4. Provider terminal states -> search seed run
  const orphanedSeeds = await db.execute(sql`
    UPDATE search_seed_runs 
    SET finished_at = NOW(), error = 'Closed via watchdog due to provider run terminal state'
    WHERE finished_at IS NULL 
    AND id IN (
      SELECT seed_id FROM provider_runs WHERE status IN ('failed', 'aborted', 'timed_out', 'manual_reconciliation_required')
    )
    RETURNING id
  `);
  orphanedSeedRuns = orphanedSeeds.rows.length;

  // 5. Autopilot System Pause Check (Queue Health)
  // If oldest pending > 30m or stuck processing > 10m -> pause. Else -> resume.
  const queueHealth = await db.execute(sql`
    SELECT 
      (SELECT count(*)::int FROM discovery_jobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes') as old_discovery,
      (SELECT count(*)::int FROM processing_jobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes') as old_processing,
      (SELECT count(*)::int FROM discovery_jobs WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes') as stuck_discovery,
      (SELECT count(*)::int FROM processing_jobs WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes') as stuck_processing
  `);
  
  const health = queueHealth.rows[0] as { old_discovery: number; old_processing: number; stuck_discovery: number; stuck_processing: number };
  const isHealthy = health.old_discovery === 0 && health.old_processing === 0 && health.stuck_discovery === 0 && health.stuck_processing === 0;

  if (!isHealthy) {
    await db.execute(sql`UPDATE autopilot_settings SET system_paused = true WHERE system_paused = false AND enabled = true`);
  } else {
    await db.execute(sql`UPDATE autopilot_settings SET system_paused = false WHERE system_paused = true AND enabled = true`);
  }

  return { failedDiscoveryJobs, failedProcessingJobs, healedProcessingJobs, stuckProviderRuns, orphanedSeedRuns, systemPaused: !isHealthy };
}
