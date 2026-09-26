# PHASE 8D Corrective Audit

Date: 2026-09-26
Branch: `neon-production-wiring`

## Verified locally

- Current Drizzle schema contains 31 tables, including queue, discovery, outreach, conversation, setter, provider, audit, rebalance, and cron tables.
- Canonical migration output is `drizzle/` with a generated base migration followed by the existing 8A and 8C additive migrations.
- Migration tracking is keyed by filename and hash, not sorted-file position. Existing legacy tracking rows with an `id` column remain compatible.
- Scheduled discovery now requires both `campaigns.status = 'active'` and `campaigns.autopilot_enabled = true` during enqueue and claim.
- Discovery budget subtracts unique candidates generated today and pending/processing work. A zero budget skips provider work.
- Deferred SERP and email-verification providers accept `disabled` and throw `ProviderDisabledError` when invoked. Scheduled non-Maps engines are not enqueued.
- Maps smoke requires `SMOKE_WORKSPACE_ID` and scopes processing claims to its campaign. The smoke campaign remains `autopilotEnabled = false`.
- `smoke:db` checks core tables, queue lease columns, migration tracking, queue indexes, replay indexes, `SELECT 1`, and a transaction round-trip.
- Broken `smoke:auth`, `smoke:instantly`, and `smoke:llm` script entries were removed rather than replaced with fake smoke tests.
- `.env.example` no longer contains obsolete Supabase or generic provider API-key names.

## Local gates

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS, 353 passed and 7 skipped
- `npm run build`: PASS
- Real Neon queue integration: NOT RUN; no safe `JOB_QUEUE_INTEGRATION_DATABASE_URL` was provided.
- Real Neon migration/smoke: NOT RUN; no operator-provided Neon URL was available in this execution.
- Real Apify smoke: NOT RUN; `APIFY_API_TOKEN` and explicit `SMOKE_WORKSPACE_ID` were not provided.
- Vercel environment verification/deploy: PENDING permission and project checks.

## Risks still open

The corrective phase cannot be marked complete until a dedicated non-production Neon database runs the migration chain, `smoke:db`, and queue integration suite, and one paid Compass run is executed with the operator's secure environment variables. No credentials were written to source, reports, or logs.
