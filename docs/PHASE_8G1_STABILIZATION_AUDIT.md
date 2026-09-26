# Phase 8G.1 Stabilization Audit

## Verified baseline

- `npm ci`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS, 371 passed, 7 skipped
- `npm run build`: PASS
- Working tree was clean at Phase 8G commit `5e360da` before this corrective phase.

## Confirmed corrective gaps

- Apify provider reservations were created after the external Actor start, allowing concurrent paid runs.
- Unknown-start reservations were not represented as durable `starting` rows.
- Async seed metrics were not replay-safe and parent seed aggregates were not restored by the poller.
- Discovery remaining-target accounting omitted active Apify work and could subtract jobs whose raw candidates were already counted.
- Autopilot bootstrap used SELECT-then-INSERT.
- Autopilot dashboard metrics used UTC and ready/outreach-ready terminology despite the current qualified target contract.
- Settings changes and their audit records were separate writes.
- Duplicate global Accounts were treated as campaign rejection instead of reusable global identity plus campaign membership.

## Production verification status

Migrations `0003_phase8f_apify_async.sql` and `0004_phase8g_autopilot_control.sql` require verification against the real Neon production database before any production-readiness claim. Vercel's sealed Neon variables were previously unavailable through the CLI, so no destructive or guessed migration operation is authorized.
