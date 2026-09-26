# Phase 8G.2 Production Audit

## Scope

This audit closes the local production-safety gaps for atomic Apify ingestion,
replay repair, target semantics, environment validation, and safe health output.
Advanced pacing, Hybrid Fill, LLM, Serper, MillionVerifier, Instantly, SMS, and
multi-actor routing remain out of scope.

## Findings and changes

- Apify dataset persistence was split across raw-candidate insertion, processing
  job enqueueing, seed finalization, and provider-run completion. A new
  `ingestApifyProviderRun` transaction locks the provider run, resolves both new
  and existing raw candidates, repairs processing jobs, finalizes seed metrics
  once, and marks the run ingested only after all writes succeed.
- Global Autopilot qualified progress now uses `COUNT(DISTINCT account_id)`;
  engine-level attribution remains membership-based.
- Autopilot progress labels use qualified target language and no longer show the
  misleading Ready buffer KPI.
- `VERCEL_ENV=production` now requires explicit `APP_ENV=production` and
  `DEV_SEED_MODE=false`; local defaults remain development-safe.
- `/api/health` exposes only status, runtime environment, provider, delivery
  mode, and database-configured state.
- `smoke:db` now proves migration filenames 0000 through 0005, Phase 8F
  provider-run columns/index, and Phase 8G/8G.1 Autopilot columns/constraint.

## Production verification blocker

No production `DATABASE_URL` or Vercel credentials are available in this local
session. Therefore production migration history, production smoke DB, deployed
health, production alias, and Vercel delivery configuration are **NOT VERIFIED**.
No production migration or destructive command was run.