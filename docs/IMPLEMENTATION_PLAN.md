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

## Phase 2 — Discovery engines, enrichment, autopilot target engine — ⬜

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
and hybrid fill, no real sends.

**Dependencies:** Phase 1.

**Risks:** Combinatorial query explosion (SERP/LinkedIn engines) — mitigated by yield-tracked seed
planner from the start, not bolted on later.

**Must NOT implement now:** Real outbound sending, AI Setter, production credential wiring.

---

## Phase 3 — Outreach infrastructure, email/SMS, channel router, suppression — ⬜

**Objective:** Turn outreach-ready prospects into safe, idempotent send jobs with a deterministic
`ChannelRouter`, sender pool management, universal suppression, and `dry_run` delivery mode.

**Prerequisites:** Phase 2 outreach-ready queue populated.

**Major modules:** `services/routing`, `infrastructure/providers/{instantly,sms}`,
`domain/compliance` (ComplianceGate/ChannelEligibilityService), `domain/outreach`.

**Database changes:** `sending_domains`, `mailboxes`, `suppression_entries`, `outreach_events` lifecycle
columns, sequence tables.

**External integrations:** Instantly (email) and an SMS provider adapter — interface + mock first; real
adapters only against documented APIs, credentials never hard-coded.

**Tests:** Channel routing preference order, concurrency (no simultaneous owner+info@), suppression
gate bypass attempts (must fail), dry-run end-to-end.

**Acceptance criteria:** Dry-run send pipeline fully exercised with zero real provider calls by default.

**Dependencies:** Phases 1–2.

**Risks:** Accidental live sends — mitigated by `delivery_mode` defaulting to `dry_run` at the schema
level (NOT NULL DEFAULT 'dry_run').

**Must NOT implement now:** AI Setter, autonomous sending, real credential activation.

---

## Phase 4 — AI Setter, reply classification, human review, learning loop — ⬜

**Objective:** Reply ingestion → deterministic pre-router → LLM classification (Zod-validated) → human
review UI → structured feedback loop. Autonomy policy engine built but disabled.

**Prerequisites:** Phase 3 conversations/outreach events exist.

**Major modules:** `domain/conversations`, `services/setter`, `infrastructure/providers/llm`.

**Database changes:** `conversations`, `conversation_messages`, `setter_drafts`, `setter_feedback`,
`meetings` finalized with branch catalog config table.

**External integrations:** LLM provider (interface + mock by default), email/SMS reply webhooks
(idempotent ingestion).

**Tests:** Idempotent webhook replays, deterministic pre-router overriding LLM on unsubscribe/bounce,
guardrail tests (no invented claims), human-in-the-loop gating.

**Acceptance criteria:** `auto_send_enabled=false` globally; every reply requires human action before
send.

**Dependencies:** Phases 1–3.

**Risks:** Prompt injection via inbound replies — mitigated by treating reply text as untrusted data,
never as instructions to the system.

**Must NOT implement now:** Enabling autosend, medical/commercial claim generation beyond approved facts.

---

## Phase 5 — Full frontend / UX / visual system — ⬜

**Objective:** Build out every product screen (Dashboard, Campaigns, Autopilot, Discovery, Accounts,
Contacts, Outreach, AI Setter, Reviews, Analytics, Infrastructure, Settings) on top of the Phase 0 design
system, wired to real (or seeded) data.

**Prerequisites:** Phases 1–4 provide the data this UI visualizes.

**Major modules:** `components/{dashboard,autopilot,campaigns,accounts,contacts,outreach,setter}`.

**Database changes:** None beyond view/query optimizations.

**External integrations:** None new.

**Tests:** Component tests for critical interactive flows (review actions, campaign creation), visual
acceptance at 1440x900.

**Acceptance criteria:** Matches §5.16 UI acceptance checklist in the master prompts.

**Dependencies:** Phases 0–4.

**Risks:** Scope creep into ecommerce-style UI patterns from reference screenshots — explicitly rejected.

**Must NOT implement now:** New backend business logic beyond what previous phases already defined.

---

## Phase 6 — QA, observability, failure modes, production hardening, release — ⬜

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
