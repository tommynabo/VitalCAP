-- PHASE 8A: Durable job queue hardening
-- Safe additive migration for Neon/Postgres queue semantics.

-- `next_attempt_at` must allow NULL for completed/dead-letter rows.
ALTER TABLE discovery_jobs ALTER COLUMN next_attempt_at DROP NOT NULL;
ALTER TABLE processing_jobs ALTER COLUMN next_attempt_at DROP NOT NULL;
ALTER TABLE outreach_queue ALTER COLUMN next_attempt_at DROP NOT NULL;

-- Generic idempotency key support for queue rows.
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Prevent duplicate in-flight jobs per idempotency key under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_jobs_idempotency_inflight
  ON discovery_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_processing_jobs_idempotency_inflight
  ON processing_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_queue_idempotency_inflight
  ON outreach_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing');

-- Exactly one dead-letter audit row per source job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dead_letter_jobs_source_job
  ON dead_letter_jobs (source_table, source_job_id);
