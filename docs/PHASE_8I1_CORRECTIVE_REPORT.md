# PHASE 8I.1 Corrective Report

Date: 2026-09-26

## GIT

HEAD: local changes based on 1830c2e; not committed or pushed in this session.

## VERCEL

Build: PASS locally.
Deployment: NOT VERIFIED; Vercel credentials/project were not available.
Alias: NOT VERIFIED.
Health: NOT VERIFIED in production.

## ENV

Database: local configuration only; production not verified.
Neon Auth: code validation PASS; production integration/base URL NOT VERIFIED.
Cookie secret configured: NOT VERIFIED; no secret value is recorded.
Apify: code validation PASS; production token NOT VERIFIED.
Legacy Maps key removed: no legacy source fallback exists; Vercel variable removal NOT VERIFIED.
Delivery: default remains dry_run; deferred providers remain disabled.

## MIGRATIONS

0000-0006: local chain present; production application NOT VERIFIED.
0007: created locally as additive corrective migration.
Production smoke: NOT RUN; requires authorized production DATABASE_URL and backup confirmation.

## AUTOPILOT COLD START

Provider untested handling: PASS locally; zero calls are `untested`, configured Apify remains eligible.
Seed bootstrap: PASS locally in discovery runner; canonical Maps catalog is idempotently bootstrapped.
First-run cap: PASS locally; untested Maps Fast work is capped at 10 raw requested items.

## PACING

Before window: zero paid scheduling in pacing and runner backstop.
After window: zero paid scheduling in pacing and runner backstop.
Budget: provider boundary caps Actor charge to remaining effective daily budget and refuses zero remaining budget.

## SEED LEARNING

Raw to Seed provenance: implemented through `search_seed_run_id`.
Raw to Provider provenance: implemented through `provider_run_id`.
Raw to Account provenance: written after account resolution.
Qualified attribution: recomputed from attributed account plus qualified membership.
Yield: parent seed totals are recomputed from persisted seed runs.
Exhaustion: qualification is not finalized until processing for the run settles.
Replay safety: ingestion and metric recomputation are idempotent by existing run/raw keys.

## REBALANCING

Qualified data: uses exact seed totals after attribution.
Cooldown: scoped to the relevant from/to campaign pair in the Autopilot runner.
Idempotency: migration 0007 provides a non-partial unique index; production verification pending.

## HYBRID FILL

Catalog expansion: approved Hybrid Maps catalog is bootstrapped before giving up.
Spain guard: uses the existing approved Spanish geography list.
ICP guard: uses the existing approved ICP category list.

## QUALITY

Tests: PASS, 402 passed and 7 skipped.
Typecheck: PASS.
Lint: PASS.
Build: PASS.

## Final Gate

Vercel deployment: FAIL - not verified.
Neon Auth: FAIL - production configuration not verified.
Apify configuration: FAIL - production token not verified.
Production migrations: FAIL - not verified.
Production smoke DB: FAIL - not run.
Cold-start provider: PASS.
Seed bootstrap: PASS.
Operating-window safety: PASS.
Budget hard cap: PASS.
Qualified seed attribution: PASS locally; production integration not verified.
Rebalancing idempotency: PASS by local contract; real Postgres verification pending.
Hybrid Fill expansion: PASS locally.
Tests: PASS.
Typecheck: PASS.
Lint: PASS.
Build: PASS.
Autopilot final state: PAUSED.

## CRITICAL REMAINING ISSUES

- Production Neon Auth, Apify, Vercel environment, alias, health, and migration chain are unverified.
- `npm run smoke:db` must be run against the real production database after confirming a current backup exists.
- Authorized GitHub push and Vercel deployment access is required to publish this commit.

READY FOR NEXT 3-PROMPT BLOCK: NO
