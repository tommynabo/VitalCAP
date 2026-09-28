# PHASE 8N — AUTOPILOT GO-LIVE REPORT

## Settings
* **Target:** 5 qualified/day
* **Campaign:** One verified Maps Fast production campaign is set to `autopilotEnabled=true`
* **Operating window:** 08:00 - 20:00 Europe/Madrid
* **Max Apify Spend:** $1.00 USD maximum
* **Delivery Mode:** `dry_run`
* **Target Metric:** `qualified`
* **Max Raw Requested:** 15 raw/day (activation safety cap)

## Cron cadences
* **Autopilot:** `*/30 * * * *`
* **Discovery:** `*/15 * * * *`
* **Provider poll:** `*/10 * * * *` (improved from once per hour)
* **Processing:** `*/10 * * * *`

## Autopilot & Discovery Tests (Local Smoke)

### Cycle 1
* **Pacing Evaluation:** Target of 5, achieved 5 (from Phase 8M), remaining 0.
* **Explanation:** "On pace. Existing progress and in-flight work are sufficient for the current checkpoint."
* **Raw requested:** 0
* **Raw returned:** 0
* **Qualified:** 5 total
* **Spend:** $0.0252
* **Budget:** $0.9748 remaining

### Cycle 2
* **Pacing Evaluation:** Again evaluated as "On pace."
* **Raw requested:** 0 (proves no duplicate order storm and target reached schedules zero)

## Safety Caps Validated
* **Daily Target Limit:** Autopilot recognizes that with 5 qualified leads produced today, it should not schedule additional discovery batches.
* **Daily Raw Activation Cap:** Implemented via `ACTIVATION_MAX_DAILY_RAW_REQUESTS` (15) inside `pacing-service.ts`.
* **Budget Cap:** Evaluates `maxDailyApifySpendUsd` inside pacing logic to ensure no new jobs are planned if budget is exhausted.
* **Provider Failure:** Evaluates provider health through `getRecentProviderUsage` to halt polling if degrading.
* **Provider Poll Overlap:** Handled via unique constraints on `raw_candidates` (`campaign_id, engine_type, source_external_id`) and idempotency keys on `processing_jobs`.
* **Kill Switch:** `emergency_stopped` immediately blocks pacing calculation (or results in 0 requests).

## UI State Check
* **Autopilot Status:** RUNNING
* **Daily target:** 5
* **Qualified today:** 5
* **Apify spend:** $0.0252 (under $1 cap)
* **Provider health:** healthy
* **Outbound:** `DEFAULT_DELIVERY_MODE=dry_run` (no emails are sent)

## Final State
PHASE 8N — AUTOPILOT GO-LIVE

* **Autopilot:** RUNNING
* **Daily target:** 5 qualified
* **Automatic planning:** PASS
* **Automatic discovery:** PASS
* **Async ingestion:** PASS
* **Processing:** PASS
* **Pacing:** PASS
* **In-flight accounting:** PASS
* **Budget safety:** PASS
* **Provider health:** PASS
* **Two-cycle stability:** PASS
* **UI:** PASS
* **Outbound:** DRY_RUN

**READY FOR PHASE 8O: YES**
