# Phase 1 Report — Domain Model, Supabase, Deduplication, Account/Contact Graph

Scope: Prompt 1 only ("DOMAIN MODEL, SUPABASE, DEDUPLICATION, ACCOUNT/CONTACT GRAPH") from
`VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`. Prompt 2 was **not** started.

## 1. What was implemented

- Full read of Prompt 1 (§1.1–§1.9) plus Appendices A–D before any code was written.
- **Domain type prerequisite fix**: `Account.countryCode` widened from the literal `"ES"` to `string`
  (ADR-008) so a rejected non-Spain seed record is representable; added `AccountDedupSignal` and
  `AccountMergeRecord` to `src/domain/accounts/types.ts`.
- **Normalization (§1.3)**: `src/lib/normalization/` — `normalizeDomain`, `normalizeUrl` (tracking-param
  stripping, www/non-www, protocol canonicalization), `normalizeEmail`, `normalizePhoneES`,
  `normalizeLinkedInUrl`, `normalizeBusinessName` (accent-safe, keeps legal-form suffixes like "S.L."),
  `normalizeAddress` (Spanish street abbreviation expansion). All 7 have unit tests; barrel `index.ts`.
- **Spain-only hard boundary (§1.4)**: `src/lib/geography/spain-provinces.ts` (50 provinces + Ceuta/
  Melilla, postal-code-prefix lookup, bounding-box helper) and `spain-eligibility.ts`'s
  `evaluateSpainEligibility()` — strong evidence (provider country code / postal code / in-bounds geo)
  verifies alone; an explicit non-ES country code rejects outright; phone/domain/province-name are
  supporting-only and never verify alone; no evidence stays `needs_review`.
- **Deduplication (§1.2, §1.8)**: `src/services/deduplication/` — `account-dedup.ts` (strong signals
  always merge; fuzzy/composite signals merge only at/above a configurable confidence threshold,
  otherwise `flag_for_review`; haversine geo-proximity), `contact-dedup.ts` (strong + full-name/account
  composite; explicitly tested that distinct named contacts on the same account never merge),
  `outreach-dedup.ts` (suppression → cooldown → account-level concurrency lock, in that order),
  `merge-record.ts` (audit record builder for `AccountMergeRecord`).
- **Contact priority (§1.5)**: `src/services/routing/contact-priority.ts` — `computeStrategicPriority()`
  implements the exact scoring table (100 named owner/titular down to 50 other generic), kept strictly
  separate from `verificationConfidence()`.
- **Verification acceptance policy (§1.6)**: `src/services/verification/acceptance-policy.ts` —
  `isContactPointAcceptable()` against a campaign-configurable `VerificationAcceptancePolicy`
  (default: `valid`/`catch_all` only). No provider-specific assumptions.
- **SQL schema (§1.1, §1.7)**: `supabase/migrations/0001_core_schema.sql` through
  `0005_rls_policies.sql` — every entity from §1.1 (workspaces/workspace_members, accounts,
  account_sources, account_merge_records, contacts, contact_points, offers, campaigns,
  campaign_memberships, discovery_jobs, raw_candidates, processing_jobs, outreach_queue,
  dead_letter_jobs, outreach_events, conversations, conversation_messages, setter_drafts,
  setter_feedback, meetings, suppression_entries), workspace-scoped RLS via an
  `is_workspace_member()` helper (joined through the nearest workspace-scoped ancestor for tables
  without a direct `workspace_id` column), and an `audit_log` table + trigger on
  `account_merge_records`/`suppression_entries` mutations.
- **Seed data (§1.9)**: `supabase/seed.sql` with all 7 required scenarios (pharmacy w/ owner+info;
  pharmacy w/ only generic; herbal shop; sports nutrition store; duplicate account from two sources;
  invalid non-Spain record; account with two decision makers). `src/lib/seed/dev-seed.ts` gained a 6th
  bundle (`acc_6`, `status: "rejected_country"`, `countryCode: "PT"`) — the previously-missing "invalid
  non-Spain record" scenario; the other 6 scenarios were already present from Phase 0's seed work.
- **Supabase client factories (§1.7)**: `src/infrastructure/supabase/client.ts`
  (`createBrowserSupabaseClient`, anon-key) and `server.ts` (`createServiceRoleSupabaseClient`, guarded
  by both the `server-only` package import and a runtime `typeof window` check). Neither is wired into
  any page — the UI still reads from `lib/seed/dev-seed.ts` only.
- Added `@supabase/supabase-js` and `server-only` to `package.json`; added `NEXT_PUBLIC_SUPABASE_URL`/
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` to `.env.example` for the browser client.
- Updated all affected READMEs (`lib/normalization`, `lib/geography`, `services/deduplication`,
  `services/routing`, `services/verification`, `infrastructure/supabase`) from "owner" stubs to
  "implemented" descriptions.
- Documentation: `docs/DATA_MODEL.md` Phase 1 addendum (SQL schema, RLS approach, dedup/eligibility/
  priority design); two new ADRs in `docs/DECISIONS.md` (ADR-007: unapplied SQL artifacts, no live
  Supabase project touched; ADR-008: `countryCode` widening); `docs/IMPLEMENTATION_PLAN.md` Phase 1
  marked complete with corrected prerequisites/tests notes.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all executed and pass (see §3).

## 2. Files created / modified

**New:**
- `src/lib/normalization/{normalize-domain,normalize-url,normalize-email,normalize-phone-es,normalize-linkedin-url,normalize-business-name,normalize-address}.ts` (+ matching `.test.ts`), `index.ts`
- `src/lib/geography/spain-provinces.ts`, `spain-eligibility.ts` (+ `.test.ts`)
- `src/services/deduplication/{account-dedup,contact-dedup,outreach-dedup,merge-record}.ts` (+ `.test.ts` for the first three)
- `src/services/routing/contact-priority.ts` (+ `.test.ts`)
- `src/services/verification/acceptance-policy.ts` (+ `.test.ts`)
- `src/infrastructure/supabase/client.ts`, `server.ts`
- `supabase/migrations/0001_core_schema.sql` … `0005_rls_policies.sql`, `supabase/seed.sql`
- `docs/PHASE_1_REPORT.md` (this file)

**Modified:**
- `src/domain/accounts/types.ts` (`countryCode` widened; `AccountDedupSignal`/`AccountMergeRecord` added)
- `src/lib/seed/dev-seed.ts` (added `acc_6` bundle)
- `.env.example`, `package.json`
- `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`
- READMEs: `src/lib/normalization/README.md`, `src/lib/geography/README.md`,
  `src/services/deduplication/README.md`, `src/services/routing/README.md`,
  `src/services/verification/README.md`, `src/infrastructure/supabase/README.md`

## 3. Tests executed and results

```
npm run lint        → 0 errors, 0 warnings
npm run typecheck   → 0 errors
npm test             → 15 test files, 67 tests, all passed
npm run build        → succeeded (Turbopack production build), all routes generated, no warnings
```

Two real bugs were caught by this test run and fixed before completion (not silently patched over):
- `normalizeAddress`'s abbreviation regex for "num." lacked a trailing boundary, so it re-matched inside
  the just-produced word "numero" (e.g. "Nº 12" → "numero ero 12"). Fixed with a negative lookahead.
- `computeStrategicPriority` scored an unrecognized generic label (e.g. "sales@") above `info@`, which
  contradicts the §1.5 ordering. Fixed by requiring a specific whitelist for the "business-specific
  generic" (65) tier instead of treating any non-info/purchasing/management label as that tier.

## 4. Build status

`next build` completes successfully; route manifest unchanged from Phase 0 (no new pages added — Prompt 1
is domain/service/SQL layer work, not UI).

## 5. Architectural decisions

See `docs/DECISIONS.md` ADR-007 (unapplied SQL artifacts; no `mcp_supabase_*` tool calls this session)
and ADR-008 (`Account.countryCode` widened to `string`). Also: `services/routing/` and
`services/verification/` now have two owners across phases (documented in their READMEs) — Phase 1 added
a narrow, self-contained piece (`contact-priority.ts`, `acceptance-policy.ts`) to each without touching
their Phase 3/Phase 2 ownership of the rest of the folder.

## 6. External services intentionally mocked / unconfigured

- **No live Supabase project provisioned or touched.** All SQL in `supabase/migrations/*.sql` and
  `supabase/seed.sql` is unapplied, unexecuted infrastructure-as-code. This was a deliberate safety
  decision, not an oversight — see ADR-007. Consequently the SQL has **not** been validated against a
  real Postgres engine (no local Postgres server, Docker, or Supabase CLI available in this environment).
- The app's UI still reads exclusively from `src/lib/seed/dev-seed.ts` (in-memory), per §1.9's explicit
  completion criterion: "UI should show seeded Accounts and Contacts but no real external calls yet."
- `createBrowserSupabaseClient`/`createServiceRoleSupabaseClient` exist but are not imported by any page.
- No email verification provider, no Maps/SERP provider — unchanged from Phase 0, out of scope for Prompt 1.

## 7. Known limitations / technical debt

- **SQL schema is unverified against a real database.** Column types, constraint syntax, RLS policy
  correctness, and the `audit_log` trigger have been written to standard Postgres/Supabase conventions
  and reviewed carefully, but never actually executed. The very first action before Phase 2 should be
  provisioning a real (or local) Postgres instance and running `supabase db push` / applying these
  migrations in order, then re-running `supabase/seed.sql`, to catch anything a static read-through
  missed (e.g. a typo'd column reference inside a `check` constraint).
- **RLS sanity tests deferred.** §1.8 asks for "RLS sanity tests where feasible" — genuinely not
  feasible without a live Postgres instance to run policies against, so none were written. This is
  called out explicitly rather than faked with a mocked-away test.
- `normalize-address.ts` and `normalize-business-name.ts` both define a local `stripAccents()` helper
  (small, intentional duplication accepted for simplicity — not extracted to a shared util).
- The RLS migration uses explicit per-table policies (not a single generic dynamic-SQL loop) because the
  FK path back to `workspace_id` differs per table (direct column vs. one/two joins) — documented inline
  in `0005_rls_policies.sql`'s header comment as a deliberate readability-over-cleverness tradeoff.

## 8. Missing credentials / provider decisions (deferred, need business input before Phase 2/3)

Unchanged from Phase 0 — no new provider credentials were required or requested in Phase 1. A real
Supabase project (URL, anon key, service-role key) is now the most immediate missing credential, needed
before the migrations in this phase can be applied for real.

## 9. Prompt 1 completion checklist (§1.1–§1.9)

| § | Requirement | Status |
|---|---|---|
| 1.1 | Normalized core entities (no generic `leads` table) | PASS — all tables modeled across 4 migration files |
| 1.2 | `DeduplicationService` (account/contact/outreach dedup, audit trail) | PASS |
| 1.3 | 7 normalization utilities, unit-tested | PASS |
| 1.4 | `SpainEligibilityService` + geography dataset | PASS |
| 1.5 | Contact priority scoring, separate from verification confidence | PASS |
| 1.6 | Verification states + campaign-configurable acceptance policy | PASS |
| 1.7 | RLS, service-role server-only, audit privileged mutations | PASS (schema written; **not applied to a live DB** — see §6/§7) |
| 1.8 | Required tests (normalizers, strong/fuzzy dedup, same-account contacts, outreach concurrency, Spain eligibility, contact priority, suppression) | PASS. RLS sanity tests: deferred (see §7) |
| 1.9 | Migrations + seed data, 7 required scenarios, UI unchanged (seed-only) | PASS |

## 10. Next phase recommendation

Prompt 2 ("DISCOVERY ENGINES, WEBSITE ENRICHMENT, EMAIL DISCOVERY, AUTOPILOT TARGET ENGINE") is the next
phase per the master document's own sequencing. Before starting it, strongly recommend: provision a real
(or local) Postgres/Supabase instance and apply+smoke-test the Phase 1 migrations and seed data for the
first time, since Phase 2's discovery engines will need a real persistence layer to write into rather
than the in-memory dev seed.

**Prompt 2 has NOT been started.** Per the master document's phase-boundary instruction ("Do not continue
into Prompt 2 automatically"), work stops here pending further instruction.
