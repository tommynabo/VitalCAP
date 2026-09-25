# Production Migration Audit (Prompt 7, Gate A)

Date: 2026-09-25
Branch: `neon-production-wiring`

## Baseline (pre-migration, validated)

```
npm ci            OK
npm run typecheck OK
npm run lint      OK
npm test          OK (329/329)
npm run build     OK
```

## What is real today

- Next.js App Router UI, domain types (`src/domain/*/types.ts`), pure
  services (`src/services/*`), validation (`src/lib/validation`), safe-fetch
  guard (`src/lib/security/safe-fetch.ts`), job-queue *semantics*
  (`src/infrastructure/jobs/job-queue.ts` — pure functions, not backed by a
  real store yet).
- `src/app/api/health/route.ts` reads `getServerEnv()` and reports
  `APP_ENV`/`DEV_SEED_MODE` — this is the only pre-existing API route.

## What is mock

- All provider adapters under `src/infrastructure/providers/**` (maps,
  serper equivalent, verification, instantly, llm) are `mock-provider.ts`
  implementations returning deterministic fake data. No real HTTP calls to
  Apify/Serper/MillionVerifier/Instantly/OpenAI exist anywhere pre-migration.

## What is seed-only

- `src/lib/seed/dev-seed.ts` (28 exports) is imported directly by all 13
  dashboard/admin pages and 2 components (`activity-rail.tsx`,
  `nav-badges.ts`). There is no repository layer — pages compute
  aggregations in-JS over the static seed arrays. This is the single largest
  gap for Gate C.

## What was Supabase-specific (removed this migration)

- `@supabase/supabase-js` dependency — removed from `package.json`.
- `src/infrastructure/supabase/{client,server,README}.ts` — deleted.
- `supabase/migrations/*.sql` + `supabase/seed.sql` — archived under
  `supabase/legacy-migrations/` (not deleted; historical reference only, not
  applied to Neon). RLS policies in `0005_rls_policies.sql` used
  `auth.uid()` (Supabase Auth) — superseded by Neon Auth session claims,
  reimplemented at the query layer (workspace-scoped repository functions)
  rather than Postgres RLS, since Neon Auth does not provide a
  `auth.uid()`-equivalent SQL function the app's serverless driver session
  can rely on without a session-scoped Postgres role per request.
- Remaining `supabase`/`SUPABASE` string matches are only in historical
  `docs/PHASE_*.md`/`docs/DECISIONS.md`/etc. (left as historical record) and
  `.env.example` (rewritten as part of Gate G).

## What is already Postgres/Neon-compatible unchanged

- All domain types, all pure services/validation, UI components, safe-fetch,
  job-queue pure semantics — none of these are Supabase-specific and require
  no changes to run against Neon.

## What needed rewriting

- Persistence: net-new Drizzle schema (`src/infrastructure/neon/schema/*`)
  built from domain types directly (fixes the documented ADR-019
  domain/schema field-parity gap — legacy Supabase SQL was missing
  `conversations.offerId/providerThreadId/latestIntent/channel` and several
  `setter_drafts`/`setter_feedback` fields the domain types already define).
- Repository layer, Neon Auth, real provider adapters, durable queue, cron
  routes, page rewiring — net new, tracked in `docs/IMPLEMENTATION_PLAN.md`
  successor sections and the PR description.

## Env vars audit

- Consumed by code before this migration: `NEXT_PUBLIC_APP_URL`, `APP_ENV`,
  `DEV_SEED_MODE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `MAPS_PROVIDER_API_KEY`,
  `SERP_PROVIDER_API_KEY`, `EMAIL_VERIFICATION_PROVIDER_API_KEY`,
  `INSTANTLY_API_KEY`, `SMS_PROVIDER_API_KEY`, `DEFAULT_DELIVERY_MODE`,
  `LLM_PROVIDER_API_KEY`, `DEFAULT_BOOKING_URL` (from `.env.example`).
- Generic `*_PROVIDER_API_KEY` names are replaced with provider-specific
  names (`APIFY_API_TOKEN`, `SERPER_API_KEY`, `MILLIONVERIFIER_API_KEY`,
  `INSTANTLY_API_KEY` unchanged, `LLM_PROVIDER_API_KEY` unchanged) — see
  `docs/ENVIRONMENT_MATRIX.md`.

## Vercel/Neon environment configuration (confirmed this session)

- Vercel project `vitalcapproject` has a Neon marketplace integration
  installed, injecting `Vitalcap_DATABASE_URL`, `Vitalcap_DATABASE_URL_UNPOOLED`,
  `Vitalcap_NEON_AUTH_BASE_URL`, `Vitalcap_NEON_PROJECT_ID`, `Vitalcap_PGHOST`,
  `Vitalcap_POSTGRES_URL`, etc. for Preview + Production.
- **BLOCKER**: pulling these via `vercel env pull` resolves to empty
  strings — the integration is installed but not actually populated/synced
  with a live Neon database connection yet. No real Neon connection is
  available in this session. This must be fixed in the Vercel dashboard
  (re-link or re-sync the Neon integration) before migrations can run for
  real. All code in this migration is written to compile/typecheck cleanly
  and is ready to run the moment a real `DATABASE_URL` is present, but has
  **not** been exercised against a live database this session.

## Known Phase 6 blockers (docs/PHASE_6_REPORT.md, docs/DECISIONS.md ADR-019)

- ADR-019: conversations/setter_drafts schema-domain field gap — fixed by
  building Drizzle schema from domain types directly (see above).
- No other Phase 6 blockers required schema changes beyond this.

## API routes found

- Only `src/app/api/health/route.ts` pre-existed. All `/api/cron/*` and
  `/api/auth/*` and `/api/webhooks/instantly` routes are net new (Gate B/E/F).
