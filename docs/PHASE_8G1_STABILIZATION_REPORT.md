# Phase 8G.1 Stabilization Report

## Local gates

| Gate | Status | Evidence |
|---|---|---|
| Dependency install | PASS | `npm ci` |
| TypeScript | PASS | `npm run typecheck` |
| Lint | PASS | `npm run lint` |
| Focused discovery/Autopilot tests | PASS | 13 passed |
| Full test suite | PASS | 371 passed, 7 skipped |
| Production build | PASS | `npm run build` |
| Diff hygiene | PASS | `git diff --check` |

## Corrective outcomes

- **Paid Apify reservation race:** PASS locally. A unique `starting` provider row is reserved before `startAsync`; only the reservation creator starts the Actor. Existing reservations, including unknown-start rows without an external run ID, are not launched again.
- **Async seed learning:** PASS locally. Polling folds raw and unique counts into the parent seed through an atomic, replay-guarded finalization.
- **Discovery budget:** PASS locally. Same-day raw candidates are counted once and active Apify capacity is subtracted by requested items; processing jobs are not double-counted.
- **Duplicate account semantics:** PASS locally. One global Account can be reused across campaigns; campaign membership follows eligibility, and disabled verification cannot produce outreach-ready membership.
- **Autopilot bootstrap:** PASS locally. Settings initialization uses `ON CONFLICT DO NOTHING` followed by SELECT.
- **Autopilot mutation audit:** PASS locally by transaction design. Settings and audit insertion share one transaction.
- **Qualified target vocabulary:** PASS locally. `target_metric` defaults to `qualified`, local metrics use workspace day bounds, and the Autopilot control surface says qualified prospects.
- **Migration:** NOT VERIFIED in production. `0003`, `0004`, and new additive `0005` require real Neon access and non-destructive verification.

## Production status

No production migration is claimed as applied or verified in this phase. Vercel sealed Neon variables were previously unavailable through the CLI. The new migration is additive only, but deployment readiness remains blocked until the real production schema is confirmed.

## Final readiness

READY FOR PHASE 8H: NO. The requested corrective phase is complete locally, but production migration verification is a hard gate and Phase 8H is explicitly out of scope.
