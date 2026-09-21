# Vitalcap Outreach OS — Implementation Plan

Source of truth: `../VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md` (read-only). This plan maps that document's
Prompts 0–6 into an execution roadmap. It is a planning artifact, not a spec replacement — when in doubt,
the master prompts document wins.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## Phase 0 — Product source of truth + repo audit + bootstrap — ✅ (complete, see `docs/PHASE_0_REPORT.md`)

**Objective:** Establish project skeleton, documentation set, domain type scaffolding, dev-mode UI shell,
and tooling — without implementing real discovery/outreach logic.

**Prerequisites:** None (greenfield repo).

**Major modules:** `src/app` shell + sidebar/topbar, `src/domain/**` type-only modules, `src/lib`,
`docs/*`, health endpoint.

**Database changes:** None. No Supabase project is provisioned in this phase; schema is only
*designed* on paper (`docs/DATA_MODEL.md`) for Prompt 1 to implement.

**External integrations:** None enabled. Reference repos (ApexEngine, FlowNex) inspected read-only via
GitHub for architectural lessons only.

**Tests:** Test framework installed (Vitest) with at least one placeholder/util test so `npm test` is
meaningful in CI from day one.

**Acceptance criteria:** See `docs/PHASE_0_REPORT.md` for the literal Prompt 0 checklist and PASS/FAIL.

**Dependencies on previous phases:** None.

**Risks:** Over-scoping into Prompt 1 territory (real Supabase schema) — mitigated by keeping Prompt 0
strictly to types + docs + shell UI.

**Must NOT implement now:** Supabase schema/migrations, discovery engines, dedup service, outreach
sending, AI Setter, real provider calls, auth flows beyond stubs.

---

## Phase 1 — Domain model, Supabase, deduplication, account/contact graph — ✅ (complete, see `docs/PHASE_1_REPORT.md`)

**Objective:** Implement the normalized core schema (`accounts`, `account_sources`, `contacts`,
`contact_points`, `offers`, `campaigns`, `campaign_memberships`, job/queue tables, outreach/conversation
tables) in Supabase Postgres with RLS, plus `DeduplicationService`, `SpainEligibilityService`, contact
priority scoring, and normalization utilities.

**Prerequisites:** Phase 0 complete. Supabase project provisioning was **not** a hard prerequisite in
practice — see `docs/PHASE_1_REPORT.md` and ADR-007: migrations/RLS/seed were written as unapplied SQL
artifacts, no live project was provisioned or touched this phase.

**Major modules:** `domain/accounts`, `domain/contacts`, `domain/campaigns`, `services/deduplication`,
`lib/normalization`, `lib/geography`, `infrastructure/supabase` client factories (browser vs
server/service-role).

**Database changes:** Full initial migration set for all Prompt 1 tables, RLS policies, unique/partial
indexes for strong dedup identities (place_id, normalized domain/phone/email).

**External integrations:** Supabase only (Auth + Postgres). No discovery/outreach providers yet.

**Tests:** Normalizers, strong/fuzzy dedup thresholds, Spain eligibility, contact priority, outreach
concurrency lock, suppression behavior. RLS sanity checks are **deferred** — they require a live Postgres
instance, which does not exist yet (see `docs/PHASE_1_REPORT.md`).

**Acceptance criteria:** Seeded synthetic Spanish accounts/contacts visible in UI tables with correct
dedup/priority behavior; no real external calls.

**Dependencies:** Phase 0 folder architecture and domain type stubs.

**Risks:** Premature coupling of dedup thresholds to UI; mitigated by keeping thresholds in config, not
component code.

**Must NOT implement now:** Live discovery engines, real email/SMS sending, AI Setter.

---

## Phase 2 — Discovery engines, enrichment, autopilot target engine — ✅ (implemented, local/mocked only)

**Objective:** Implement the 5 discovery engines behind a shared interface, geography planner, website
enrichment + email extraction/verification adapters (mocked), and the Autopilot Target Engine
(scheduler, target planner, quota rebalancer, queue health, provider health, pacing).

**Prerequisites:** Phase 1 domain model + dedup service in place.

**Major modules:** `domain/discovery`, `services/enrichment`, `services/verification`,
`infrastructure/providers/{maps,serp,email-verification,linkedin}`, `domain/autopilot`,
`infrastructure/jobs`.

**Database changes:** `discovery_jobs`, `raw_candidates`, `processing_jobs`, `search_seeds`,
`search_seed_runs`, provider usage/cost tracking tables.

**External integrations:** Maps/Places provider, SERP provider, email verification provider — all via
mock/dev adapters unless credentials are supplied; real adapters implemented against documented APIs
only.

**Tests:** Engine dry-run behavior, dedup pre-flight before enrichment, queue idempotency/retry/backoff,
rebalancer math, Spain-boundary rejection, provider-outage handling.

**Acceptance criteria:** Fully mocked local simulation of the 250/day target with soft-target rebalancing
and hybrid fill, no real sends. **Met** — see `src/services/autopilot/simulate-autopilot-day.ts` and
`docs/PHASE_2_REPORT.md`.

**Dependencies:** Phase 1.

**Risks:** Combinatorial query explosion (SERP/LinkedIn engines) — mitigated by yield-tracked seed
planner from the start, not bolted on later.

**Must NOT implement now:** Real outbound sending, AI Setter, production credential wiring.

---

## Phase 3 — Outreach infrastructure, email/SMS, channel router, suppression — ✅ (implemented, local/mocked only, see `docs/PHASE_3_REPORT.md`)

**Objective:** Turn outreach-ready prospects into safe, idempotent send jobs with a deterministic
`ChannelRouter`, sender pool management, universal suppression, and `dry_run` delivery mode.

**Prerequisites:** Phase 2 outreach-ready queue populated.

**Major modules:** `services/outreach` (ChannelRouter, sender pool, channel mix planner, sequence
service, message renderer, event ingestion, dry-run orchestrator), `services/compliance` (suppression
service, `ComplianceGate`), `infrastructure/providers/{instantly,sms}` (mock `EmailDeliveryProvider` /
`SmsDeliveryProvider`), `domain/providers` (delivery provider interfaces), `lib/normalization`
(`classifyPhoneTypeES`).

**Database changes:** None applied — `sending_domains`, `mailboxes`, `suppression_entries` and
`outreach_events` lifecycle columns were already defined in Phase 1's unapplied SQL
(`0003_jobs_schema.sql`, `0004_outreach_conversations_schema.sql`); Phase 3 only builds the pure-function
services and in-memory seed data against those already-designed shapes.

**External integrations:** Instantly (email) and an SMS provider — both mock-only adapters this phase,
reusing Phase 2's deterministic-fixture pattern. No live credentials wired.

**Tests:** Channel routing preference order (owner > purchasing > manager > named > role email >
generic > info@), one-active-path concurrency + account cooldown, suppression gate bypass attempts
(must fail), sender pool capacity/health, 125/125 mix planning with shortfall reporting, cold/warm
sequence pause-on-reply and cancel-on-bounce, idempotent webhook ingestion (HMAC signature + dedup by
`providerEventId`), and a `simulate-outreach-day.test.ts` integration test — 42 outreach-scoped tests
(230 total repo-wide), all passing.

**Acceptance criteria:** Dry-run send pipeline fully exercised with zero real provider calls by default —
**met**: `runOutreachDryRunCycle` never imports `MockInstantlyEmailDeliveryProvider` /
`MockSmsDeliveryProvider`, only records planned `OutreachQueueItem`/`OutreachEvent` pairs.

**Dependencies:** Phases 1–2.

**Risks:** Accidental live sends — mitigated by `deliveryMode` defaulting to `"dry_run"` in every queue
item constructed by the orchestrator; flipping to live is out of this phase's scope entirely.

**Must NOT implement now:** AI Setter, autonomous sending, real credential activation.

---

## Phase 4 — AI Setter, reply classification, human review, learning loop — ✅ (implemented, mock LLM only, see `docs/PHASE_4_REPORT.md`)

**Objective:** Reply ingestion → deterministic pre-router → LLM classification (Zod-validated) → human
review UI → structured feedback loop. Autonomy policy engine built but disabled.

**Prerequisites:** Phase 3 conversations/outreach events exist.

**Major modules:** `domain/conversations` (extended with `providerThreadId`, `detectedFactsRequested`,
`suggestedNextAction`, `SetterFeedback.meetingOutcome`/`qualified`/`lostReason`), `domain/providers`
(`LLMProvider`, `SetterPromptContext`, `SetterClassificationOutput`), `services/setter` (pre-router,
context builder, Zod output schema, guardrails, classify-and-draft retry/fallback orchestration, reply
ingestion, human review service, feedback analytics, autonomy policy engine, warm follow-up scheduler,
setter orchestrator), `infrastructure/providers/llm` (`MockLLMProvider`).

**Database changes:** None applied — `conversations`, `conversation_messages`, `setter_drafts`,
`setter_feedback`, `meetings` remain Phase 1's unapplied SQL shapes; Phase 4 only builds the pure-function
services and in-memory seed data against those already-designed shapes (domain types extended additively,
no breaking changes).

**External integrations:** LLM provider — mock-only (`MockLLMProvider`) this phase, deterministic
keyword classification + template drafting reusing Phase 2's `hashString`/`seededRandom` fixture
pattern. No real LLM API is called.

**Tests:** Deterministic pre-router (unsubscribe/do-not-contact/hard-negative/OOO/bounce/meeting-booked/
wrong-person/spam) always suppressing before any LLM call; guardrails rejecting invented forbidden
claims and escalating non-approved commercial negotiation; Zod-validated structured output with a
retry-once-then-`HUMAN_REQUIRED`-fallback path; idempotent reply webhook ingestion (dedup by
`providerMessageId`); all six human review actions; feedback analytics (branch accuracy, approval/edit/
rejection rate, confidence calibration); autonomy policy engine (built, never wired to an actual send);
warm follow-up queue (pause on reply/meeting/unsubscribe/human ownership); a `simulate-setter-day.test.ts`
integration test — 76 setter-scoped tests (306 total repo-wide), all passing.

**Acceptance criteria:** `AUTO_SEND_ENABLED = false` globally (hardcoded constant, not read by any send
path) — **met**; every reply requires human action before send — **met**: `processIncomingReply` only
ever produces a `pending_review`/`suppressed`/`pre_routed` conversation state, never `sent`, and
`applyReviewDecision` is the only function that can move a conversation to `sent`.

**Dependencies:** Phases 1–3.

**Risks:** Prompt injection via inbound replies — mitigated by treating reply text as untrusted data
passed through a whitelisted `SetterPromptContext` (never raw DB dumps, never instructions), never as
instructions to the system. Guardrails independently re-check the LLM's own output rather than trusting
`needsHuman`/`riskFlags` as reported.

**Must NOT implement now:** Enabling autosend, medical/commercial claim generation beyond approved facts.

---

## Phase 5 — Full frontend / UX / visual system — ✅ (implemented, see `docs/PHASE_5_REPORT.md`)

**Objective:** Build out every product screen (Dashboard, Campaigns, Autopilot, Discovery, Accounts,
Contacts, Outreach, AI Setter, Reviews, Analytics, Infrastructure, Settings) on top of the Phase 0 design
system, wired to real (or seeded) data.

**Prerequisites:** Phases 1–4 provide the data this UI visualizes.

**Major modules:** `components/ui/{button,select,input,tabs,table,skeleton,empty-state,error-state,sheet,charts}`,
`components/dashboard/activity-rail`, `components/layout/{sidebar-context,nav-badges}`; every page under
`app/(dashboard)/*` rewritten or extended; additive seed data in `lib/seed/dev-seed.ts` (weekly trend,
provider rows, verification usage, search seeds, queue health, dead-letter samples).

**Database changes:** None — UI-only phase, no `domain/` or `services/` files changed.

**External integrations:** None new.

**Tests:** No new component tests added this phase (UI-only, no new business logic to unit-test); full
existing 306-test suite re-verified passing with no regressions. `npx tsc --noEmit`, `npm run lint`, and
`npm run build` all clean across all 14 routes.

**Acceptance criteria:** Matches §5.16 UI acceptance checklist in the master prompts — see
`docs/PHASE_5_REPORT.md` for the full per-item checklist. Every nav destination is a real page; no
`PhasePlaceholder`-wrapped screens remain in the main navigation; sidebar is collapsible with numeric
badges and a mobile drawer; loading/empty/error state primitives exist and are used where applicable.

**Dependencies:** Phases 0–4.

**Risks:** Scope creep into ecommerce-style UI patterns from reference screenshots — explicitly rejected;
no charting library was added (dependency-free SVG/div chart primitives instead) to avoid over-engineering.

**Must NOT implement now:** New backend business logic beyond what previous phases already defined — none
was added.

---

## Phase 6 — QA, observability, failure modes, production hardening, release — ✅ (implemented, see `docs/PHASE_6_REPORT.md`)

**Objective:** Harden the system: idempotency audits, DB constraints/indexes, security review (RLS,
SSRF, webhook verification, secrets), performance pass, recovery runbooks, production checklist.

**Prerequisites:** Phases 1–5 feature-complete.

**Major modules:** No major new features — cross-cutting fixes only.

**Database changes:** Constraint/index hardening only.

**External integrations:** None new; existing ones get real health checks/alerts.

**Tests:** End-to-end flows A–I from §6.1 of the master prompts.

**Acceptance criteria:** `docs/PRODUCTION_CHECKLIST.md` fully checked; real outbound remains disabled
until an explicit `delivery_mode: live` change by an authorized user.

**Dependencies:** All previous phases.

**Risks:** Pressure to "just enable sending" — explicitly disallowed by Appendix C non-negotiables.

**Must NOT implement now:** N/A (final hardening phase) — but must NOT silently flip any safety default.

---

## Cross-phase non-negotiables (Appendix C)

Enforced starting in Phase 0 and never violated in later phases: Spain-only, autopilot-first, 5 engines
with soft targets + 250 global target, no fake quota completion, producer/processor separation, ready
buffer, accounts/contacts/contact_points separation, pre-enrichment dedup, multi-contact-per-account,
no simultaneous multi-endpoint contact by default, no Apollo/data-broker for owner discovery, provider
abstractions everywhere, public-source evidence for named contacts, channel eligibility ≠ endpoint
existence, universal suppression, no hard-coded commercial facts/IDs/URLs, human review at launch, no
hallucinated Setter facts, idempotent webhooks, retryable/observable jobs, premium non-developer UI, no
manual-generator-as-core-screen, no client-side secrets, real outbound disabled until go-live.
