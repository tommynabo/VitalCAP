# Phase 8B Migration Audit

Date: 2026-09-25
Branch: `neon-production-wiring`

## Reviewed files

- `supabase/migrations-neon/0001_phase8a_job_queue_hardening.sql`

## Safety review

The migration is additive and idempotent:

- `ALTER TABLE ... DROP NOT NULL` changes queue completion/dead-letter columns to the nullable semantics required by the repository.
- `ADD COLUMN IF NOT EXISTS` adds queue idempotency keys.
- `CREATE UNIQUE INDEX IF NOT EXISTS` adds in-flight idempotency protection and dead-letter deduplication.

No `DROP TABLE`, `DROP COLUMN`, destructive type conversion, data deletion, or Supabase `auth.*` dependency was found.

## Concerns

- This branch contains the Phase 8A hardening migration, but no base Neon schema migration. The base tables must already exist before applying `0001_phase8a_job_queue_hardening.sql`.
- The Drizzle schema and the reviewed SQL agree on the Phase 8A queue columns and indexes. The migration runner refuses to apply a changed file after it has been recorded.
- Production must never be reset or migrated with `drizzle push`.

## Decision

**SAFE TO APPLY ONLY TO A DATABASE THAT ALREADY CONTAINS THE BASE VITALCAP TABLES.**

The migration itself is non-destructive. A database-state inspection and a successful `smoke:db` run are required before considering production migration complete.