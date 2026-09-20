# infrastructure/supabase

Implemented in Phase 1 (Prompt 1 §1.7):

- `client.ts` — `createBrowserSupabaseClient()`, anon-key, RLS-scoped.
- `server.ts` — `createServiceRoleSupabaseClient()`, server-only (guarded by
  the `server-only` package import + a runtime `typeof window` check),
  bypasses RLS — only for trusted server code.

Neither factory is wired into any page yet. The app still runs entirely on
`lib/seed/dev-seed.ts` — no Supabase project is provisioned, and the SQL in
`supabase/migrations/*.sql` has never been applied to a live database (see
`docs/DECISIONS.md` ADR-002 and ADR-007).
