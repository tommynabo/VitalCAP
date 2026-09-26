# PHASE 8D - CORRECTIVE CONSOLIDATION

Date: 2026-09-26
Branch: `neon-production-wiring`

## Git HEAD

`2bdec2a17fc1767ada71d96dce72d25938f10281` (`feat: consolidate phase 8d neon safety gates`), followed by the report-only publication update.

## MIGRATIONS

- Base migration: PASS locally; generated from the current Drizzle schema at `drizzle/0000_base_schema.sql`.
- Migration tracking: PASS by inspection and typecheck; filename/hash identity is independent of lexical order.
- Fresh test DB: NOT RUN; no safe Neon test database was supplied.
- Production migration/baseline: NOT RUN; production database must not be touched without an explicit reviewed operator command.

## NEON

- Connection: NOT VERIFIED in this execution.
- Smoke DB: NOT RUN; requires a real Neon URL.
- Auth smoke: removed as no meaningful standalone smoke file existed; the auth route remains covered by the application build.

## JOB QUEUE REAL DB

- Concurrent claim: implementation covered; real DB NOT RUN.
- Lost lease: implementation covered; real DB NOT RUN.
- Retry/backoff: implementation covered; real DB NOT RUN.
- Dead-letter: transactional implementation covered; real DB NOT RUN.
- Idempotency: schema and repository covered; real DB NOT RUN.
- Campaign gate: scheduled claim requires active + autopilot enabled.

## DISCOVERY SAFETY

- AutopilotEnabled gate: PASS in enqueue selection and claim SQL.
- `remainingTarget`: PASS in implementation; generated-today unique candidates and in-flight processing are subtracted.
- Cron accidental-spend protection: PASS locally; disabled autopilot is not scheduled/claimable. Real DB NOT RUN.

## APIFY

- Compass actor: configured as `compass/crawler-google-places`.
- Real request: NOT RUN; secure `APIFY_API_TOKEN` was not supplied.
- Requested/returned/cost/provider run/raw candidates/accounts/Spain eligibility: NOT VERIFIED.
- Replay idempotency: covered by unique indexes and local code/tests; real DB NOT RUN.

## ENV

- Legacy vars removed from `.env.example`: PASS.
- Deferred providers can be explicitly disabled: PASS.
- Broken npm scripts removed: PASS.
- Vercel names verified: NOT VERIFIED; the CLI JSON response was not parseable without exposing values.

## SECURITY

- Apify token in Git: NO token was written by this change.
- Outbound: no paid smoke or outbound provider was invoked.
- Delivery mode: defaults to `dry_run`.

## QUALITY

- Tests: PASS, 353 passed and 7 skipped.
- Typecheck: PASS.
- Lint: PASS.
- Build: PASS.
- Vercel: PASS for deployment; production alias is `https://vitalcapproject.vercel.app`. HTTP health verification was blocked by a local TLS failure.

## CRITICAL REMAINING ISSUES

- Real Neon migration, smoke, and queue integration tests still need a dedicated non-production Neon database.
- Real five-result Compass smoke still needs secure `APIFY_API_TOKEN` and explicit `SMOKE_WORKSPACE_ID`.
- Vercel environment presence and deployment still require authenticated project access.

## ACCEPTANCE

READY FOR NEXT 3-PROMPT BLOCK: NO

The hard acceptance cannot be marked complete until real Neon queue tests and the real five-place Apify smoke pass.
