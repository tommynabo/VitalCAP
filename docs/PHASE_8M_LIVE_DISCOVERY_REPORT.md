# Phase 8M - Live Maps Fast Discovery Activation Report

## Objective
Prove the real production pipeline end-to-end with one small paid Apify Maps run on Vercel Edge/Serverless environments, without enabling live outreach or other active integrations.

## Execution Flow Validated

1. **Autopilot / DiscoveryOrder** 
   - Autopilot settings enabled for the workspace.
   - Enqueued `maps_search` job for a Campaign.
2. **SearchSeed**
   - Correctly initialized with tracking of `raw_count`, `unique_count`, and `ready_count`.
3. **Apify Actor (Maps Fast Engine)**
   - Vercel-deployed Cron `/api/cron/discovery` correctly dispatched the `startAsync` run to Apify (idempotent, single batch run).
   - Actor input strictly validated for Apify JSON Schema (e.g. `countryCode: "es"` casing fix).
4. **provider_run**
   - Correctly reserved in `starting` status and moved to `queued` on successful Apify launch.
5. **Apify dataset / Ingestion**
   - Vercel-deployed Cron `/api/cron/provider-runs` correctly polled Apify, retrieved the 5 `items_returned`, and pulled the default dataset.
   - Removed `db.transaction()` wrapper from ingestion edge path (`provider-run-ingestion.ts` and `discovery.ts`) due to Drizzle ORM `neon-http` constraints in Vercel Serverless/Edge functions.
6. **raw_candidates & processing_jobs**
   - 5 raw candidates accurately ingested.
   - 5 `process_raw_candidate` processing jobs triggered idempotently.
7. **dedup & Account & campaign_membership & qualified**
   - Vercel-deployed Cron `/api/cron/process` parsed the raw payloads, created 5 distinct `Account` records, and generated 5 `campaign_membership` records at the `qualified` stage.

## Bugs Discovered & Fixed During Production Smoke
- **Vercel Serverless Transactions**: Drizzle ORM `neon-http` driver throws "No transactions support in neon-http driver" on Vercel for nested or interactive `.transaction()` calls. Refactored `ingestApifyProviderRun` and `refreshSearchSeedQualification` to execute sequentially without the transaction wrapper.
- **Apify Actor Schema Validation**: Apify Google Maps actor rejected the ISO country code `"ES"`. Re-configured `compass-adapter.ts` to emit `"es"` (lowercase) which passed validation.
- **Provider Run Constraints**: The unique constraint on `provider_runs` was strictly enforcing `actor_id` which wasn't fully supplied by the async layer. Fixed the schema to support the proper unique configuration and fallback logic.

## Safety & Budget Check
- Apify maximum charge was strictly capped at $0.25 limit as instructed.
- Actual charge observed: $0.0252 for the single smoke test.
- No live outreach emails, Instantly, Serper, or SMS webhooks were executed. Delivery mode remains safely in `dry_run`.

## Next Steps
- Verify Vercel cron schedules are active in `vercel.json` if automated triggering is desired.
- Set Autopilot back to `PAUSED`.
- Proceed to Phase 8N or live campaign enablement!
