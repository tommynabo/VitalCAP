# Phase 6 Report — QA, Observability, Failure Modes, Production Hardening, Release

Source of truth: `VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`, Prompt 6 (§6.1–§6.11). This is the **final**
phase of the master prompts — completing it finishes the entire multi-phase VitalCap Outreach OS project.

## Summary

Phase 6 is deliberately a hardening-only phase: no new product features were added. Work consisted of
(1) an end-to-end critical-flow regression test suite covering all nine named flows in §6.1, which
surfaced and fixed one real production bug (an unhandled verification-provider exception that would have
crashed the whole candidate pipeline), (2) a small observability module (structured logging + metrics +
an admin diagnostics composer) and a non-nav `/admin/diagnostics` page consuming it, (3) a DB hardening
migration fixing three real schema/domain-drift CHECK-constraint bugs plus a missing idempotency-backing
unique index, found and validated against a throwaway local Postgres instance (never a live database),
and (4) five audit/reference documents (idempotency, security, performance, recovery runbook, production
checklist) capturing the current state of the system's reliability posture and what remains before any
real deployment.

## Implemented files

**Tests (`src/services/qa/`)**
- `critical-flows.test.ts` — new file, 11 tests across `describe` blocks for Flows A–I from §6.1, each
  composed from existing, already-unit-tested production service functions rather than re-testing
  internals: Maps Fast happy path + single-endpoint routing (A); owner-priority routing +
  concurrent-send blocking (B); account merge via dedup signal + duplicate-send blocking after merge
  (C); Spain-boundary rejection for PT/FR/AD (D, `it.each`); LinkedIn Owner forced-paused rebalancing
  (E); verification-provider outage graceful degradation + provider-health pause + job retry-with-backoff
  (F); reply → draft → review → send same-thread continuity (G); unsubscribe cancels the sequence, not
  merely pauses it (H); risky/hallucinating LLM output forces human review (I).

**Bug fix (`src/services/discovery/`)**
- `candidate-processor.ts` — wrapped `verifyEmailsWithCache(...)` in a try/catch; on a thrown error, all
  contact points now fall back to `verificationStatus: "unverified"` (correctly rejected by
  `DEFAULT_VERIFICATION_ACCEPTANCE_POLICY`) instead of the exception propagating and crashing the entire
  candidate-processing pipeline.
- `candidate-processor.test.ts` — added a regression test for the above (`describe("... verification
  provider outage (Prompt 6 §6.1 Flow F)")`).

**Observability (`src/lib/observability/`, all new)**
- `structured-logger.ts` / `.test.ts` — pure log-line builder (correlation ID, job ID, campaign ID,
  account ID when relevant, provider, duration, outcome — per §6.2's required fields); `logEvent` is the
  only function with a side effect (writes to `console`). Never logs secrets — no field accepts a raw
  credential value.
- `metrics.ts` / `.test.ts` — pure aggregation functions over provider usage / queue / outcome data for
  the metrics required by §6.2 (provider latency/errors, provider cost, etc.).
- `admin-diagnostics.ts` / `.test.ts` — `buildAdminDiagnostics(input)` composes a **precomputed**
  `QueueHealthSnapshot` (caller-supplied via `evaluateQueueHealth(jobs, now)`, or reused directly from
  seed data whose shape already matches) with cron-staleness (26h threshold), webhook-staleness (7-day
  threshold), provider-all-connected, and DB-connectivity checks into one `AdminDiagnosticsSnapshot` with
  an `overallHealthy` boolean.

**Admin diagnostics page (`src/app/admin/diagnostics/`, new)**
- `page.tsx` — deliberately placed **outside** the `(dashboard)` route group, so it renders with only
  the root layout (no `AppShell`/sidebar/topbar) and is not listed in `NAV_ITEMS`
  (`src/components/layout/nav-config.ts`, a static array with no auto-discovery) — confirmed via
  `npm run build`'s route list showing `/admin/diagnostics` as its own independent static route. Renders
  queue health, provider health, cron/webhook freshness, DB connectivity, current target state, and
  dead-letter samples.
- `src/lib/seed/dev-seed.ts` — three new additive exports (`seedCronLastRunAt`, `seedWebhookLastEventAt`,
  `seedDbConnectivityOk`) feeding the new page; no existing export changed.

**Database hardening (`supabase/migrations/0006_phase6_hardening.sql`, new)**
- Fixed `conversations.state`: had no CHECK constraint at all, and its `default 'active'` wasn't even a
  member of the 14-value `ConversationState` domain enum — added the correct CHECK and changed the
  default to `'reply_received'` (the actual initial application state).
- Fixed `conversation_messages.direction`: CHECK allowed `('inbound','outbound')`; domain type is
  `"incoming" | "outgoing"` — every real insert would have failed. Corrected.
- Fixed `setter_drafts.review_decision`: CHECK allowed `('approved','rejected','corrected')`; domain
  `ReviewDecision` union is `approve | edit_and_send | reject | no_reply_needed | escalate | suppress` —
  corrected.
- Added `idx_conversations_workspace_state`, `idx_meetings_workspace_scheduled_for`,
  `idx_dead_letter_jobs_created_at` for the dashboard/diagnostics queries that need them.
- Added `uq_outreach_events_provider_event_id` (partial unique index, found during the §6.4 idempotency
  audit) — backs the application-level webhook-replay dedup with a real DB constraint.
- **Validated for real, twice, against a throwaway local Postgres 16 instance** (via Postgres.app's
  precompiled binaries — `initdb`/`pg_ctl` on ports 5544/5545, a stubbed `auth.users`/`auth.uid()` schema
  since the app targets Supabase specifically): all six migrations (0001–0006) apply cleanly in order
  with `ON_ERROR_STOP=1`; the three corrected CHECK constraints were proven to reject the old wrong
  literal and accept the correct domain literal. Every throwaway instance was fully torn down afterward
  (`pg_ctl stop` + `rm -rf` the data/log files) — **no live or production database was ever touched.**

**Documentation (`docs/`, all new except `DECISIONS.md`)**
- `IDEMPOTENCY_AUDIT.md` — scenario-by-scenario write-up of all six required §6.4 scenarios; five fully
  covered by existing code, one (worker crash after provider success/before DB commit) partially
  mitigated and documented as a pre-go-live blocker requiring provider-specific logic that can't be
  built against mock providers.
- `SECURITY_REVIEW.md` — RLS, secret exposure, webhook verification, SSRF, auth-on-mutations,
  open-redirect, rate-limiting, and injection review.
- `PERFORMANCE_REVIEW.md` — the six §6.7 anti-patterns reviewed; most are either already mitigated or
  not-yet-applicable (no live DB/large data volume yet), with pagination and cron-batch-size flagged as
  required before go-live.
- `RUNBOOK.md` — all eight §6.8 recovery procedures, each citing the exact field/function that backs it.
- `PRODUCTION_CHECKLIST.md` — all ~20 §6.9 items as actionable unchecked checkboxes, plus a "known
  blockers" section cross-referencing ADR-019 and the other four docs above.
- `DECISIONS.md` — appended ADR-019 (the three CHECK-constraint fixes + the deliberately-deferred
  `conversations`/`setter_drafts` field-parity gap) and an addendum documenting the
  `provider_event_id` unique index fix found during the idempotency audit.

## Provider matrix

Unchanged from every previous phase — reiterated here per §6.11's explicit instruction ("do not claim a
provider is connected unless it was actually tested"):

| Provider | Adapter shipped | Ever called against a real API? |
|---|---|---|
| Maps (business discovery) | `MockMapsProvider` | ❌ No |
| Google SERP | `MockSerpProvider` | ❌ No |
| LinkedIn (owner discovery) | mocked via SERP-shaped results | ❌ No |
| Website fetch (contact extraction) | `MockWebsiteFetcher` / `safeFetchPage` (real fetch wrapper, never invoked against a live target in tests) | ❌ No |
| Email verification | `MockEmailVerificationProvider` | ❌ No |
| Email delivery (Instantly) | not implemented — dry-run orchestrator only | ❌ No |
| SMS delivery | not implemented — dry-run orchestrator only | ❌ No |
| LLM (AI Setter) | `MockLLMProvider` | ❌ No |

Every provider adapter is deterministic (seeded via `hashString`/`seededRandom`) so tests are
reproducible. No credential has ever been used against a real third-party API in this project.

## Schema overview (delta from Phase 1)

`supabase/migrations/0001`–`0005` unchanged from Phase 1 (never applied to any live database — see
`docs/DECISIONS.md` ADR-002). `0006_phase6_hardening.sql` (this phase) is additive-only: three
`CHECK`-constraint corrections, one default-value correction, four new indexes. **Known limitation
carried forward, not fixed this phase:** `conversations` is still missing `offer_id`/`provider_thread_id`/
`latest_intent` columns and `setter_drafts` is still missing several Phase 4 domain fields (documented
in ADR-019) — deliberately deferred rather than speculatively redesigned with no live database to
validate against. This is a hard blocker in `docs/PRODUCTION_CHECKLIST.md` before those tables are wired
to real reads/writes.

## Route/page inventory (delta from Phase 5)

All 14 Phase-5 routes unchanged. One new route added this phase:
- `/admin/diagnostics` — internal operations diagnostics, **not** in `NAV_ITEMS`, **not** wrapped in
  `AppShell` (renders with only the root layout) — confirmed via `npm run build`'s route table showing it
  as an independent static route alongside, not nested under, the dashboard group.

## Test results

- `npx vitest run` — **329/329 tests passing** (61 test files) — up from 306 at the end of Phase 5:
  +11 new critical-flow tests (§6.1), +1 candidate-processor regression test, +11 observability module
  tests (structured-logger 4, metrics 3, admin-diagnostics 4).
- `npx tsc --noEmit -p .` — clean, no errors.
- `npm run lint` (ESLint 9) — clean, no errors or warnings.
- `npm run build` (Next.js 16 Turbopack) — clean production build, all 15 routes generate successfully
  (14 static + `/api/health` dynamic; `/admin/diagnostics` is static).

## Known limitations

- **`conversations`/`setter_drafts` schema-vs-domain field gaps** (ADR-019) — deliberately deferred, not
  fixed this phase; blocks wiring those tables to real Supabase reads/writes until resolved.
- **No live cron or webhook route exists yet** — the idempotency guarantees for duplicate-cron-run and
  duplicate-webhook-delivery are verified at the pure-function/unit level, not yet end-to-end against a
  real duplicate HTTP request to a real route (because no such route has been built yet — that's Phase
  1-era infrastructure that was never required to go beyond the pure-function layer, since no live
  deployment exists).
- **Worker-crash-after-provider-success-before-DB-commit** is only partially mitigated (dedup key +
  cooldown + concurrency lock) — full protection requires a provider-specific "check before re-send"
  step that cannot be built or validated against mock providers. Documented in
  `docs/IDEMPOTENCY_AUDIT.md` and `docs/PRODUCTION_CHECKLIST.md` as a pre-go-live blocker.
- **No pagination yet** on dashboard list views — acceptable today given the deliberately small seed
  dataset, flagged as required before real, larger data volumes are wired in (`docs/PERFORMANCE_REVIEW.md`).
- **No rate limiting** — not yet needed (no public-facing mutation/webhook route exists), flagged as
  required before any such route is deployed (`docs/SECURITY_REVIEW.md`).
- **RLS has never been tested against a live Supabase project** — the policies are comprehensive and
  internally consistent by inspection, but "deny by default, explicit membership check" behavior should
  still be spot-checked with a real anon-role query once a project exists, per standard practice, not
  assumed correct purely from reading the migration file.

## Deployment guide (delta from Phase 0)

No change to the deployment target (Vercel + Supabase, per ADR-001) or to the fact that no project has
been provisioned yet. What's new this phase: `docs/PRODUCTION_CHECKLIST.md` is now the authoritative,
actionable pre-deployment checklist (superseding any informal notes from earlier phases), and
`docs/RUNBOOK.md` is the reference for the first operational incidents that will come up post-launch.

## Release-safety defaults (§6.10) — verified, not reimplemented

- `DEFAULT_DELIVERY_MODE` defaults to `"dry_run"` via a Zod enum default in
  [src/lib/config/env.ts](../src/lib/config/env.ts) (`z.enum(["dry_run", "live"]).default("dry_run")`),
  confirmed by `env.test.ts`'s `"never defaults DEFAULT_DELIVERY_MODE to live"` assertion.
- `AUTO_SEND_ENABLED` is a hardcoded `false as const` in
  [src/services/setter/autonomy-policy.ts](../src/services/setter/autonomy-policy.ts) — not read from
  any env var, so it cannot be flipped by a misconfigured deployment; confirmed by
  `autonomy-policy.test.ts`. No send path imports `canAutoSend` at all yet (structural inertness, per
  ADR-012's pattern), so autosend requires a deliberate, separately-reviewed code change even after this
  constant is eventually flipped.
- New AI Setter conversations start in `pending_review`-equivalent states requiring human action before
  any send (`applyReviewDecision`'s `"approve"` path is the only route to `state: "sent"` in the existing
  setter-orchestrator test suite) — no code change was needed or made here; this was already true from
  Phase 4 and is simply re-confirmed as still true.

No code changes were made for this section — it is a verification-only checklist item per the master
prompt's explicit instruction not to reimplement what already exists correctly.

## First-week operating procedure

Once a real deployment exists and `docs/PRODUCTION_CHECKLIST.md` is fully checked:
1. Run with `delivery_mode: dry_run` for the entire first week regardless of how confident the checklist
   sign-off feels — this matches §6.10's release rule (discovery/enrichment/verification live, delivery
   dry-run) and lets an operator visually confirm real output (right accounts, right contact points,
   right rendered messages, no unsuppressed contact ever selected) before any real send is possible.
2. Check `/admin/diagnostics` daily (queue health, provider health, cron/webhook freshness, DB
   connectivity) — this is the fastest single view to catch a stuck queue, an expired provider key, or a
   stale cron before it becomes a bigger problem.
3. Review the dead-letter panel daily — anything landing there in week one is either a real bug not yet
   caught by the test suite, or a config problem (bad credential, wrong URL) — both are cheap to fix
   early and expensive to discover after volume ramps up.
4. Only after a full week of clean dry-run output, an authorized operator explicitly flips
   `delivery_mode: live` for one pilot campaign — never globally on day one.
5. Re-run the suppression test (`docs/PRODUCTION_CHECKLIST.md`) again immediately after the live flip,
   against the real (not seed) database, before the first real send goes out.
6. Keep `docs/RUNBOOK.md`'s emergency-stop procedure one click away (bookmarked, or the `/autopilot` page
   pinned) for the entire first week — the fastest fix for almost any first-week surprise is pausing
   outbound, not debugging live.

## Prompt 6 acceptance checklist (§6.1–§6.11)

| § | Requirement | Status |
|---|---|---|
| 6.1 | Critical-flow tests A–I | ✅ `src/services/qa/critical-flows.test.ts`, 11 tests, all passing |
| 6.2 | Observability: metrics + structured logs | ✅ `src/lib/observability/{structured-logger,metrics}.ts` |
| 6.3 | Admin diagnostics view, not in salesperson nav | ✅ `/admin/diagnostics`, outside `(dashboard)` group, not in `NAV_ITEMS` |
| 6.4 | Idempotency audit, 6 scenarios | ✅ `docs/IDEMPOTENCY_AUDIT.md` — 5 covered, 1 partially mitigated + documented gap |
| 6.5 | DB constraints (unique/partial indexes, FKs, checks, dashboard/queue indexes) | ✅ `supabase/migrations/0006_phase6_hardening.sql`, validated against real throwaway Postgres |
| 6.6 | Security review | ✅ `docs/SECURITY_REVIEW.md` |
| 6.7 | Performance review | ✅ `docs/PERFORMANCE_REVIEW.md` |
| 6.8 | Recovery runbook, 8 procedures | ✅ `docs/RUNBOOK.md` |
| 6.9 | Production checklist | ✅ `docs/PRODUCTION_CHECKLIST.md` |
| 6.10 | Release rule: outbound disabled by default | ✅ verified `DEFAULT_DELIVERY_MODE=dry_run`, `AUTO_SEND_ENABLED=false`, no reimplementation needed |
| 6.11 | Final deliverable | ✅ this report + all cross-referenced docs; provider matrix confirms no provider was ever really tested |

## Project status

**Phase 6 is complete. This was the final phase in `VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`. All six
phases (0–6) are now complete.** The system remains fully in dry-run/mock-provider mode with no live
database or deployment, per every safety default reviewed above — exactly as required before any real
go-live.
