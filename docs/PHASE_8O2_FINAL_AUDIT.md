# PHASE 8O.2 - FINAL AUDIT

## 0. PAUSE AUTOPILOT
Checked real Production DB. Autopilot was paused (enabled = false, system_paused = true).

## 1. MIGRATION STATE
0010_phase8o_reliability_fix.sql is applied. We will not modify it. We will use 0011_phase8o2_final_reliability.sql.

## 2. CODE AUDIT & PLAN

### A. Provider Ingestion State Machine
Currently, the local state transitions directly from `running`/`queued` to `succeeded` if it succeeds, but the ingestion claims require `succeeded`. Wait, the prompt says "Current bug: local provider_run.status = running/queued, Apify API returns: SUCCEEDED... code calls claimProviderRunForIngestion... but claim requires local status = succeeded".
I need to:
1. Atomically persist `status = succeeded`, `external_dataset_id`, `cost`, `finished_at`.
2. THEN attempt `succeeded → ingesting` with an `ingestion_claim_token`.

### B. Ingestion Saga Final Write
`ingested` must be the final write. I will refactor `provider-runs-runner.ts` to ensure this.

### C. Remove Neon HTTP Interactive Transactions
I will search for `db.transaction(async tx => ...)` and replace them with CTEs or safe update logic. Affected files include `job-queue.ts`, `discovery.ts`, `autopilot.ts`, `campaigns.ts`, etc.

### D. Fingerprint Canonization
I will add `buildRawSourceFingerprint` to `discovery.ts` (or equivalent) and ensure it's used everywhere. 

### E. Qualified At Monotonicity
I will enforce that `stage` transitions are monotonic and `qualified_at` is preserved in `campaigns.ts`.

### F. Pacing Model
`rawRequestedToday` vs `rawReturnedToday`. I will update the metrics.

### G. UI Panel
Implement the 8O Panel on `/autopilot` or `/infrastructure` with the exact operational snapshot fields.

Will run `npm run db:generate` to verify the schema matches 0011.
