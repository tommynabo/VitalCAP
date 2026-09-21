# Security Review (Prompt 6 §6.6)

Scope: review the codebase as it stands at the end of Phase 6 against the OWASP Top 10 and the
specific concerns called out in the master prompt (RLS, secret exposure, webhook verification, SSRF).
This is a document-what-exists review, not a penetration test — there is no live deployment yet.

---

## Row Level Security (RLS)

[supabase/migrations/0005_rls_policies.sql](../supabase/migrations/0005_rls_policies.sql) enables RLS on
every table introduced in 0001-0004 with no exceptions. Design:

- A single `is_workspace_member(target_workspace_id)` `security definer` helper checks
  `workspace_members` against `auth.uid()` — every policy calls through this one function rather than
  duplicating the membership check inline, so there is one place to audit/fix if the membership model
  ever changes.
- Tables that carry `workspace_id` directly get a straightforward `using`/`with check` pair.
- Tables that don't carry `workspace_id` directly (`account_sources`, `outreach_events`,
  `conversation_messages`, `setter_drafts`, `setter_feedback`, etc.) are scoped via an explicit `exists`
  join back through their real parent (account, campaign, outreach_queue, or conversation) to that
  parent's `workspace_id` — each join path was written out by hand per-table rather than attempting one
  generic dynamic policy, specifically because the FK path to `workspace_id` genuinely differs per
  table (documented in the migration's own header comment).
- `dead_letter_jobs.campaign_id` is nullable (a job can outlive its campaign); the policy explicitly
  requires `campaign_id is not null` before checking membership, so a null-campaign dead-letter row is
  **denied by default** rather than accidentally matching every workspace.
- `audit_log` has RLS enabled with **zero** policies defined — this is intentional (per the migration's
  comment): enabling RLS with no policy denies all access to normal (anon/authenticated) roles, leaving
  only the service-role key able to read it. Correct pattern for a privileged audit trail.

**Verdict:** comprehensive and consistent. No table was found unprotected. This has not been tested
against a live Supabase project yet (no project provisioned this phase) — flagged in
`docs/PRODUCTION_CHECKLIST.md` as a required verification step once one is provisioned (Supabase's
"RLS enabled with no policy = deny all" behavior should be spot-checked with a real anon-role query per
table, not just read off the migration file).

## Secret / credential exposure

[.env.example](../.env.example) — every variable name is documented, no real secrets committed. The
Supabase section explicitly separates:
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — commented as "browser-safe... only
  grants RLS-scoped anon access, never bypasses it."
- `SUPABASE_SERVICE_ROLE_KEY` — commented "Server-side only. NEVER expose to the browser /
  NEXT_PUBLIC_* prefix." Not referenced anywhere in client component code (only server-side
  `src/lib/config/env.ts`-style access would ever read it, and no such usage exists yet since
  `DEV_SEED_MODE=true` means no Supabase client is constructed at all in this phase).
- `CRON_SECRET`, all provider API keys, and `LLM_PROVIDER_API_KEY` are all server-only names with no
  `NEXT_PUBLIC_` prefix.

`src/app/api/health/route.ts` (the only API route that exists) returns only `APP_ENV` and
`DEV_SEED_MODE` — no secret values, no stack traces, no internal paths.

**Verdict:** the env var naming convention correctly separates public from private, and is followed
everywhere it's referenced. No secret is ever logged (see `structured-logger.ts` — the new §6.2
observability module's log line builder takes structured fields, none of which include raw provider
keys anywhere in the codebase).

## Webhook signature verification

[src/services/outreach/outreach-event-ingestion.ts](../src/services/outreach/outreach-event-ingestion.ts):
`verifyWebhookSignature` computes an HMAC-SHA256 over the raw request body with the shared secret and
compares it to the provided signature using `timingSafeEqual` (constant-time, prevents a timing side
channel from leaking the correct signature byte-by-byte). Rejects if the header is missing or the
lengths differ before ever calling `timingSafeEqual` (which requires equal-length buffers). Tested:
accepts a correctly signed payload, rejects a missing header, rejects a tampered payload, rejects the
wrong secret.

**Verdict:** solid. No live webhook endpoint exists yet to wire this into (no `src/app/api/webhooks/*`
route), so this is a verified building block, not yet an end-to-end-tested route — flagged in the
production checklist.

## SSRF protection

[src/lib/security/safe-fetch.ts](../src/lib/security/safe-fetch.ts) — used whenever the discovery
pipeline fetches a candidate's website for contact-point extraction (an attacker-influenced URL, since
it comes from scraped business listings):
- Scheme allowlist: only `http:`/`https:`, rejects anything else (`file:`, `gopher:`, etc.) before any
  request is made.
- Hostname blocklist: `localhost`, `0.0.0.0`, `metadata.google.internal`, and any `.local`/`.internal`/
  `.localhost` suffix.
- IP-literal blocklist covering loopback, RFC1918 private ranges, and link-local (`169.254.0.0/16`,
  which includes the `169.254.169.254` cloud metadata endpoint) for both IPv4 and IPv6.
- Redirects are followed **manually** (never delegated to the underlying `fetch`), one hop at a time,
  and every hop is re-validated against the same scheme/hostname/IP checks — a malicious site cannot
  redirect through a public URL into a private one after the initial check passes.
- Optional DNS-resolution re-check (`resolveHostname`) re-validates the hostname's resolved IPs are not
  private, closing the DNS-rebinding gap where a hostname resolves to a public IP at check-time and a
  private IP at request-time (available where a resolver can be injected; a no-op fallback exists for
  edge/browser runtimes with no DNS API, documented as a runtime limitation in the code comment).
- Bounded timeout (8s default), content-length cap (2MB default), and content-type allowlist
  (`text/html`/`text/plain` only) prevent large-response and non-HTML-payload abuse.

**Verdict:** thorough, defense-in-depth SSRF mitigation, and it is exercised in tests
(`safe-fetch.test.ts`) for the blocked-hostname/blocked-IP/redirect-revalidation cases.

## Authentication / authorization on mutation endpoints

There are currently no mutation-capable API routes (`src/app/api/health/route.ts` is the only route and
is a read-only `GET`). All "mutations" in the app today happen through pure service functions called
directly by page/component code against in-memory dev-seed data (`DEV_SEED_MODE=true`) — there is no
live database and no real user session to authorize yet. This is **not a gap to fix in this phase**:
Prompt 6 explicitly says not to add major new features, and building real authenticated API routes
against a database that doesn't exist yet would be speculative. Flagged explicitly in
`docs/PRODUCTION_CHECKLIST.md` as a hard blocker before go-live: every future mutation route must check
the caller's session against Supabase Auth and rely on RLS as the enforcement backstop (never trust a
client-supplied `workspace_id` alone).

## Open redirects

No user-controlled redirect target exists anywhere in the app (`next/navigation`'s `redirect()`/
`router.push()` calls found during the survey all use hardcoded internal paths, e.g. navigating between
dashboard routes) — there is no login-return-URL or similar pattern yet that would accept an external
URL from a query parameter. Nothing to fix; flagged as something to specifically re-check once a real
auth flow (which commonly introduces a `?next=` or `?returnTo=` parameter) is added.

## Rate limiting

No rate limiting exists yet, and there is currently no live public-facing endpoint that would need it
(the one API route is a static health check; no webhook route exists yet either). Flagged in
`docs/PRODUCTION_CHECKLIST.md` as required before any real webhook/cron route is deployed publicly —
recommend Vercel's edge middleware or a simple token-bucket keyed by source IP / provider once those
routes exist.

## Injection (SQL / XSS)

- No raw SQL string concatenation exists anywhere in the codebase (no live DB access yet — all
  persistence is in-memory dev-seed data structures). When a real Supabase-backed repository layer is
  built, it must use the Supabase client's parameterized query builder or `$1`-style parameterized raw
  SQL (per the existing `NEVER_DESTRUCTIVE_DB` operational rule already in place for this project) —
  not string interpolation.
- No `dangerouslySetInnerHTML` usage was found anywhere in `src/`. All rendered user-influenced content
  (business names, message templates, conversation text) goes through normal React JSX text
  interpolation, which auto-escapes.

## Summary

| Area | Status |
|---|---|
| RLS | Comprehensive, consistent, every table covered — not yet tested against a live project |
| Secret exposure | Correctly separated public/private env vars, no secrets in logs or routes |
| Webhook verification | HMAC + constant-time compare, tested — no live route wired yet |
| SSRF | Scheme/hostname/IP/redirect/DNS-rebinding defenses, tested |
| Auth on mutations | N/A yet (no live DB/session) — hard blocker documented for go-live |
| Open redirects | No occurrences found; nothing to fix, flagged to re-check once auth ships |
| Rate limiting | Not implemented; not yet needed (no public routes); flagged for go-live |
| SQL/XSS injection | No raw SQL, no `dangerouslySetInnerHTML`; guidance recorded for future DB layer |
