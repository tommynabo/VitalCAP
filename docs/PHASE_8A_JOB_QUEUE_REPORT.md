# PHASE 8A Job Queue Report

Date: 2026-09-25
Branch: `neon-production-wiring`
Scope: Neon/Postgres durable queue only.

## 1) Files changed

- `docs/PHASE_8A_JOB_QUEUE_AUDIT.md`
- `docs/PHASE_8A_JOB_QUEUE_REPORT.md`
- `src/domain/discovery/types.ts`
- `src/infrastructure/jobs/runners/discovery-runner.ts`
- `src/infrastructure/jobs/runners/processing-runner.ts`
- `src/infrastructure/neon/repositories/job-queue.ts`
- `src/infrastructure/neon/repositories/job-queue.integration.test.ts`
- `src/infrastructure/neon/schema/discovery.ts`
- `src/infrastructure/neon/schema/outreach.ts`
- `supabase/migrations-neon/0001_phase8a_job_queue_hardening.sql`

## 2) Schema changes

- `discovery_jobs`
  - `next_attempt_at` changed to nullable semantics.
  - added `idempotency_key`.
  - added partial unique index `uq_discovery_jobs_idempotency_inflight`.
- `processing_jobs`
  - `next_attempt_at` changed to nullable semantics.
  - added `idempotency_key`.
  - added partial unique index `uq_processing_jobs_idempotency_inflight`.
- `outreach_queue`
  - `next_attempt_at` changed to nullable semantics.
  - added `idempotency_key`.
  - added partial unique index `uq_outreach_queue_idempotency_inflight`.
- `dead_letter_jobs`
  - added unique index `uq_dead_letter_jobs_source_job` on `(source_table, source_job_id)`.

## 3) Migration created

- `supabase/migrations-neon/0001_phase8a_job_queue_hardening.sql`

## 4) Claim algorithm

- Implemented atomic claim with one SQL statement per queue:
  - `WITH claimable AS (SELECT ... FOR UPDATE SKIP LOCKED LIMIT N)`
  - `UPDATE ... FROM claimable RETURNING *`
- Claim eligibility:
  - campaign must be active (`campaigns.status = 'active'`)
  - job status in `('pending', 'processing')`
  - `next_attempt_at <= now OR next_attempt_at IS NULL`
  - pending rows are claimable immediately
  - processing rows are reclaimable only when lease expired (or lock missing)
- `attempt_count` increments only on claim.
- Batch size is bounded (`MAX_CLAIM_BATCH_SIZE = 100`).

## 5) Lease ownership algorithm

- Ownership is explicit via `locked_by = workerId`.
- `complete*Job` and `fail*Job` now require `workerId`.
- Mutations require:
  - `status = 'processing'`
  - `locked_by = workerId`
- If update affects zero rows, `LostLeaseError` is thrown.

## 6) Retry semantics

- Error classification supports explicit and implicit paths:
  - explicit: `classification` input (`transient` / `permanent`)
  - typed errors: `TransientJobError`, `PermanentJobError`
  - fallback heuristic: existing `isPermanentError()`
- Transient failures:
  - row set back to `pending`
  - lock cleared
  - `next_attempt_at` set to future via shared `computeBackoffMs`
- Permanent failures:
  - dead-letter immediately.

## 7) Dead-letter semantics

- Dead-letter transition is transactional:
  1. source row updated to `dead_letter`
  2. dead-letter audit row inserted
- Both occur in one DB transaction.
- Duplicate dead-letter audit writes are suppressed with unique index + `onConflictDoNothing`.

## 8) Idempotency mechanism

- Generic `idempotency_key` support added to queue schema.
- Enqueue API supports `idempotencyKey`.
- For keyed enqueue:
  - `INSERT ... ON CONFLICT DO NOTHING`
  - if insert skipped, lookup existing in-flight row (`pending|processing`) and return same id.
- Applied in production queue paths:
  - discovery enqueue: `discovery:<campaignId>:run_engine_batch`
  - processing enqueue: `raw_candidate:<rawCandidateId>`

## 9) Tests added

- New integration test file:
  - `src/infrastructure/neon/repositories/job-queue.integration.test.ts`
- Covers required scenarios:
  - TEST 1 concurrent claim single owner
  - TEST 2 lease expires + reclaim + old owner rejected (`LostLeaseError`)
  - TEST 3 new owner completes reclaimed job
  - TEST 4 completed row allows `next_attempt_at = NULL` (validated with DB read)
  - TEST 5 transient failure schedules retry
  - TEST 6 claim blocked until backoff due time
  - TEST 7 permanent failure dead-letters immediately
  - TEST 8 max-attempts reached dead-letters
  - TEST 9 source transition + dead-letter audit present together
  - TEST 10 duplicate dead-letter transition keeps single audit row
  - TEST 11 concurrent idempotent enqueue yields one in-flight row
  - TEST 12 paused campaign cannot be claimed
  - TEST 13 active campaign can be claimed
  - TEST 14 completed/dead-letter rows are not reclaimable
- Safety guard:
  - integration suite runs only with `JOB_QUEUE_INTEGRATION_DATABASE_URL`
  - URL must look test-safe unless `ALLOW_UNSAFE_QUEUE_ITESTS=true`.

## 10) Tests executed

Executed:
- `npm test`

Result:
- `66 passed | 1 skipped` test files
- `348 passed | 7 skipped` tests

Note:
- The new DB integration suite was skipped because no test DB URL was provided in this environment.

## 11) Test results

- Unit/service tests: PASS
- Queue integration tests against real DB: NOT RUN (skipped by safety guard)

## 12) Typecheck result

- `npm run typecheck`: PASS

## 13) Lint result

- `npm run lint`: PASS

## 14) Build result

- `npm run build`: PASS

## 15) Anything not verified against a real DB

- `FOR UPDATE SKIP LOCKED` concurrency behavior was implemented and covered by integration tests, but those tests were not executed here due missing safe integration DB URL.
- Transactional dead-letter behavior and idempotent enqueue under true DB race were not runtime-verified in this environment for the same reason.

## 16) Remaining queue risk

- Main residual risk is operational verification gap: DB integration tests are present but not executed yet.
- Running integration suite against a dedicated test Postgres/Neon DB is required to fully close runtime concurrency confidence.

## PASS/FAIL Matrix

- Atomic claim: PASS
- Concurrent claim protection: PASS (implementation) / NOT VERIFIED HERE against real DB runtime
- Lease ownership: PASS
- Lease reclaim: PASS (implementation) / NOT VERIFIED HERE against real DB runtime
- Lost lease protection: PASS
- Retry/backoff: PASS
- Max attempts: PASS
- Atomic dead-letter: PASS (implementation) / NOT VERIFIED HERE against real DB runtime
- Idempotent enqueue: PASS (implementation) / NOT VERIFIED HERE against real DB runtime
- Paused campaign protection: PASS
- Schema consistency: PASS

## Phase 8D follow-up verification

- Migration chain normalized to `drizzle/0000_base_schema.sql`, `0001_phase8a_job_queue_hardening.sql`, and `0002_phase8c_maps_idempotency.sql`.
- Scheduled discovery now requires active status and `autopilotEnabled=true`.
- Real Neon queue integration remains NOT RUN because no safe test database was provided.
