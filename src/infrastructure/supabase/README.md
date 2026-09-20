# infrastructure/supabase

Owner: Phase 1. Will host the browser client (anon key, RLS-scoped) and the
server/service-role client (server-only, never imported from client
components). In Phase 0 the app runs entirely on `lib/seed/dev-seed.ts` and
no Supabase project is provisioned — see `docs/DECISIONS.md` ADR-002.
