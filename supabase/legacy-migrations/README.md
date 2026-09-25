# Legacy Supabase migrations (archived, Prompt 7)

These SQL files were the Phase 1–6 Supabase-targeted schema. They were
**never applied to any live database** (see the header note in
`0001_core_schema.sql` and `docs/DECISIONS.md` ADR-007). Supabase is no
longer the production database — Neon Postgres is (see
`src/infrastructure/neon/`).

Kept for historical reference only:
- data model lineage / diff against the new Drizzle schema,
- the original RLS policy design intent (`0005_rls_policies.sql`), reused
  conceptually for Neon Row Level Security in
  `src/infrastructure/neon/schema/rls.sql`.

Do not apply these files to any database. Do not add new migrations here.
New schema changes go through `drizzle-kit generate` and land under
`drizzle/`.
