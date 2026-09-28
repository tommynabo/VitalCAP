# Phase 8O: Production Discovery Reliability & Self-Healing Audit

## Objective
Audit live production data from Phase 8M/8N and design the self-healing and watchdog mechanics required to keep the Apify/Neon discovery pipeline healthy without manual supervision.

## Production Observations

1. **`provider_runs`**:
   - We observed intermittent Apify API timeouts during `startActor` calls, which left `provider_runs` in a `starting` state with no `external_run_id`.
   - Long-running maps operations occasionally exceeded typical 1-2 hour limits but were never marked as `timed_out` locally, blocking the pipeline from retrying or failing gracefully.

2. **`discovery_jobs` and `processing_jobs`**:
   - Vercel execution limits (especially with serverless execution) caused some jobs to silently timeout. While Neon `FOR UPDATE SKIP LOCKED` natively handles leases on retry (which naturally heals crashed workers by reclaiming the job once `locked_at + lease` expires), jobs exceeding `max_attempts` could infinitely loop if not correctly dead-lettered.

3. **`raw_candidates`**:
   - Edge cases in parsing or schema mismatches caused processing jobs to fail permanently, leaving `raw_candidates` with `processed = false`. A watchdog sweep is required to detect these orphans and re-enqueue idempotent `process_raw_candidate` jobs.

4. **`search_seed_runs`**:
   - Failed or aborted provider runs left `search_seed_runs` indefinitely open (null `finishedAt`). They must be deterministically closed to reflect their terminal state and avoid blocking future seed exhaustion logic.

5. **`dead_letter_jobs`**:
   - Permanent errors (e.g., Zod validation failures due to unseen Apify structures) correctly landed here. However, no automatic sweeping existed for jobs hitting `attemptCount >= maxAttempts`.

## Architectural Decisions for Watchdog

1. **Queue Health Auto-Pause (`system_paused`)**:
   - We introduced `systemPaused` to `AutopilotSettings`.
   - If the watchdog detects jobs stuck in `pending` for >30 minutes or jobs stuck in `processing` for >10 minutes, it automatically flags `system_paused = true`.
   - This stops *new* paid discovery jobs (`claimDiscoveryJobs` ignores paused workspaces), but allows `claimProcessingJobs` to continue running to drain the backlog.

2. **Cost Intelligence**:
   - We can dynamically extract Apify spend and yield metrics via `getAutopilotPacingState()` to observe cost per raw and cost per qualified prospect.

3. **Non-Destructive Healing**:
   - No automatic destructive repairs.
   - We do not run paid Actor calls in the watchdog.
   - Ambiguous `starting` runs with no `external_run_id` are explicitly moved to `manual_reconciliation_required` (which we added to the schema).

## Next Steps
- Implement `/api/cron/watchdog` route in Vercel crons.
- Develop `scripts/smoke/run_cron_chain_phase8o.ts` to simulate the full pipeline.
- Verify `system_paused` logic works as intended.
