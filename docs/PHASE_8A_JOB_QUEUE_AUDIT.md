# PHASE 8A Job Queue Audit

Date: 2026-09-25
Branch: `neon-production-wiring`
Scope: Durable Postgres/Neon job queue only (`discovery_jobs`, `processing_jobs`, `outreach_queue`, `dead_letter_jobs`, queue repository, runners, retry/backoff, campaign-status gating, queue tests).

## Files inspected

- `src/infrastructure/neon/schema/discovery.ts`
- `src/infrastructure/neon/schema/outreach.ts`
- `src/domain/discovery/types.ts`
- `src/infrastructure/neon/repositories/job-queue.ts`
- `src/infrastructure/neon/repositories/discovery.ts`
- `src/infrastructure/jobs/runners/discovery-runner.ts`
- `src/infrastructure/jobs/runners/processing-runner.ts`
- `src/infrastructure/jobs/job-queue.ts`
- `src/infrastructure/jobs/job-queue.test.ts`
- `supabase/legacy-migrations/0003_jobs_schema.sql`
- `supabase/legacy-migrations/0006_phase6_hardening.sql`

## Current queue tables

### `discovery_jobs`
- Columns include `status`, `attempt_count`, `max_attempts`, `locked_at`, `locked_by`, `next_attempt_at`, `last_error`.
- Current Drizzle schema marks `next_attempt_at` as `NOT NULL` with default `now()`.
- Dispatch index exists on `(status, next_attempt_at)`.

### `processing_jobs`
- Same queue shape and indexes as `discovery_jobs`.
- Current Drizzle schema also marks `next_attempt_at` as `NOT NULL` with default `now()`.

### `outreach_queue`
- Has queue-style columns (`status`, attempts, lock fields, `next_attempt_at`) plus outreach-specific fields.
- Current Drizzle schema marks `next_attempt_at` as `NOT NULL` with default `now()`.
- No queue claim/complete/fail repository currently implemented for outreach.

### `dead_letter_jobs`
- Audit table keyed by `source_table`, `source_job_id`, campaign, payload, attempt count, last error.
- Current schema has a non-unique index on `(source_table, source_job_id)`.
- No uniqueness constraint preventing duplicate dead-letter audit rows.

## Current claim mechanism

Implementation file: `src/infrastructure/neon/repositories/job-queue.ts`

- Claim uses one SQL statement with:
  - `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`
  - campaign join and `c.status = 'active'` gating
  - statuses considered claimable: `pending` and lease-expired `processing`
- Attempt count increments at claim time (`attempt_count = attempt_count + 1`).
- Lock fields are set on claim (`locked_at`, `locked_by`).

## Current retry mechanism

- Retry logic in repository uses shared `computeBackoffMs` and `isPermanentError` from `src/infrastructure/jobs/job-queue.ts`.
- `fail*Job` behavior:
  - transient: set status back to `pending`, clear lock, set `next_attempt_at` to future timestamp.
  - permanent or attempts exhausted: set status to `dead_letter`, clear lock, set `next_attempt_at = NULL`, insert dead-letter row.

## Current lease mechanism

- Lease timeout is parameterized in claim (`DEFAULT_LEASE_MS = 5 minutes` in repo).
- Reclaim condition: processing row is claimable when `locked_at + lease <= now`.
- Reclaim assigns a new `locked_at` and current caller `locked_by`.

## Current dead-letter mechanism

- Dead-letter operation is two writes:
  1. update source job to `dead_letter`
  2. insert into `dead_letter_jobs`
- These writes are currently **not wrapped in one DB transaction**.

## Current idempotency behavior

- Queue enqueue (`enqueueDiscoveryJob`, `enqueueProcessingJob`) always inserts a new row.
- No `idempotency_key` column exists on queue tables.
- No unique queue-level idempotency protection exists under concurrent enqueue.
- `ensureDiscoveryJobsQueued` has an app-level `hasInFlightDiscoveryJob` check, but this is not a DB-level concurrency-safe idempotency guarantee.

## Confirmed bugs

1. **`next_attempt_at` schema contradiction**
   - Current schema: `next_attempt_at NOT NULL` on `discovery_jobs`/`processing_jobs`/`outreach_queue`.
   - Current repository writes `next_attempt_at = NULL` on completion and dead-letter.
   - This is inconsistent and will fail once enforced by real DB constraints.

2. **Lost lease protection missing**
   - `complete*Job` updates by `id` only.
   - `fail*Job` updates by `id` only.
   - No `WHERE ... status='processing' AND locked_by=?` ownership check.
   - A worker that lost lease can still complete/fail late and overwrite newer ownership.

3. **Dead-letter transition not atomic**
   - Source update and dead-letter insert are separate statements without transaction.
   - Possible split-brain state if second write fails.

4. **Dead-letter duplicate protection missing**
   - No unique constraint on `(source_table, source_job_id)`.
   - Duplicate audit rows are possible under races/retries.

5. **Enqueue is not idempotent/concurrency-safe**
   - No idempotency key; concurrent duplicate inserts are possible.

6. **Claim eligibility and nullable `next_attempt_at` mismatch**
   - Claim filter currently uses `next_attempt_at <= now` only.
   - If queue semantics allow NULL due times, such rows are never claimable.

7. **Queue API does not make ownership explicit**
   - `complete*Job(jobId)` and `fail*Job(job, error)` do not require explicit `workerId` ownership assertion.

## Already-correct behavior

1. Claim operation for discovery/processing is atomic SQL with `FOR UPDATE SKIP LOCKED`.
2. Claim path enforces campaign status gate (`campaigns.status = 'active'`), so paused/draft/archived campaigns are not newly claimed.
3. Lease expiration allows crash recovery reclaim.
4. Attempt counting increments on claim (not on failure).
5. Completed/dead-letter jobs are not claimable because claim query only targets `pending`/`processing`.
6. Retry backoff uses shared utility, avoiding per-runner duplicated backoff formulas.

## Current testing state

- Existing tests (`src/infrastructure/jobs/job-queue.test.ts`) are pure function tests only.
- No current DB-backed integration tests validate `FOR UPDATE SKIP LOCKED`, lease-loss rejection, atomic dead-letter transactionality, or enqueue idempotency under concurrency.
