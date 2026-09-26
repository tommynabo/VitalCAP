# Phase 8B — Neon Real Validation

Date: 2026-09-25
Branch: `neon-production-wiring`

## Environment and safety

- Vercel project is linked and exposes `Vitalcap_DATABASE_URL` and `Vitalcap_DATABASE_URL_UNPOOLED` by name for Preview and Production.
- Vercel CLI returned empty encrypted values for both database variables in this session. No database URL, password, token, or connection string was printed or retained.
- Because the values are empty, Neon could not be reached and no migration was applied to any database.
- No cron, discovery, provider, AI, or outreach execution was triggered.

## Implementation delivered

- Added `scripts/migrate.ts`: idempotent, hash-checked migration runner for versioned Neon SQL.
- Added `scripts/smoke/smoke-db.ts`: metadata-only connection, table, queue-column, index, and transaction smoke check.
- Documented `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in `.env.example`.
- Added an explicit production seed-mode regression test.
- Audited `supabase/migrations-neon/0001_phase8a_job_queue_hardening.sql` in `docs/PHASE_8B_MIGRATION_AUDIT.md`.

## Migration audit

**PASS for the reviewed Phase 8A SQL.** It contains no `DROP TABLE`, `DROP COLUMN`, data deletion, destructive type conversion, or `auth.*` dependency. It is additive/idempotent, but it assumes the base VitalCAP tables already exist.

## Runtime results

| Criterion | Result |
|---|---|
| `DATABASE_URL` available | FAIL: Vercel value empty in this session |
| Neon reachable | NOT RUN: no usable credential |
| Drizzle/migration files exist | PASS: versioned SQL plus runner exist |
| Migration audit safe | PASS |
| Test database migration | NOT RUN |
| Production migration | NOT APPLIED |
| Core/queue tables and constraints | NOT VERIFIED against Neon |
| Atomic concurrent claim | NOT RUN against real DB; implementation test exists but is skipped without a safe URL |
| Lost lease protection | NOT RUN against real DB |
| Retry/backoff | NOT RUN against real DB |
| Max attempts | NOT RUN against real DB |
| Atomic dead-letter | NOT RUN against real DB |
| Dead-letter dedup | NOT RUN against real DB |
| Idempotent enqueue | NOT RUN against real DB |
| Paused campaign protection | NOT RUN against real DB |
| Production smoke DB | NOT RUN |
| No Supabase runtime dependency | PASS in application wiring; legacy SQL remains historical and is not used by the Neon runner |
| Production seed-mode protection | PASS: explicit test added |
| Typecheck | PASS |
| Lint | PASS |
| Tests | PASS locally; real DB suite skipped |
| Build | PASS |

## Remaining critical issues

1. The Neon/Vercel integration must be re-linked or synchronized so the two database variables contain usable values.
2. A dedicated test branch/database must be supplied before running `npm run db:migrate`, `npm run smoke:db`, and the real queue integration suite.
3. Production migration remains unapplied. It must not be inferred from this report.

## Final status

**PHASE 8B = FAIL / BLOCKED** because real Neon connectivity and queue integration were not proven.

**READY FOR PHASE 8C: NO**

## Phase 8D follow-up verification

- Added a current-schema base migration at `drizzle/0000_base_schema.sql` and order-safe filename/hash migration tracking.
- Local typecheck, lint, tests, and build pass.
- Fresh Neon migration, `smoke:db`, production baseline, and real queue integration remain NOT RUN because no safe Neon database was provided.