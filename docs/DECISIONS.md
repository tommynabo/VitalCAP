# Architecture Decision Log

Concise ADR-style log. Newest entries at the bottom. Each entry: decision, rationale, alternatives
considered, consequences.

---

## ADR-001: Stack — Next.js (App Router) + TypeScript strict + Tailwind + shadcn/ui + Supabase

**Decision:** Use Next.js App Router, TypeScript in strict mode, Tailwind CSS, shadcn/ui primitives,
Supabase (Postgres + Auth) as the primary stack, deployable to Vercel.

**Rationale:** Explicitly the preferred stack in Prompt 0 §0.7. Mature, well-documented, good fit for a
desktop-first operational SaaS with server components for privileged data access and a clean path to
Vercel Cron for background jobs.

**Alternatives considered:** Remix + a separate API service; plain Vite SPA + Express backend. Rejected
because they add operational surface (separate deploy targets) without benefit for this product shape,
and the master prompts explicitly prefer Next.js + Supabase + Vercel.

**Consequences:** Domain/service logic must be kept out of route handlers and React components (own
`domain/`, `services/`, `infrastructure/` layers) so business logic remains framework-agnostic and
unit-testable, per Prompt 0 quality rules.

---

## ADR-002: No premature Supabase project provisioning in Phase 0

**Decision:** Do not create a real Supabase project or run any migrations in Phase 0. Model the schema
only on paper (`docs/DATA_MODEL.md`) and keep the app running against an in-memory/dev seed data layer
behind the same repository interfaces Phase 1 will implement with Supabase.

**Rationale:** Prompt 0 explicitly says "add development seed mode" and "do not yet implement all
provider logic." Creating a real cloud project this early would require secrets before any code needs
them and risks a half-configured, unaudited RLS setup.

**Alternatives considered:** Provision Supabase immediately so Phase 1 has "less setup." Rejected —
violates the phase boundary and the non-negotiable of not exposing service-role keys before RLS is
designed.

**Consequences:** Phase 1 must implement a Supabase-backed adapter behind the same repository interface
introduced in Phase 0, so no domain code needs to change — only the infrastructure binding.

---

## ADR-003: Domain-first folder structure per Appendix A, adapted minimally

**Decision:** Adopt the `src/{app,components,domain,services,infrastructure,lib,types,tests}` structure
from Appendix A verbatim, with domain types as pure TypeScript (no framework imports) from day one.

**Rationale:** Appendix A is explicitly "a direction, not an unbreakable exact path," but no
contradicting requirement exists, so following it maximizes compatibility with Prompts 1–6.

**Alternatives considered:** Feature-folder structure (`features/accounts/...`) common in some Next.js
apps. Rejected for this project because the master prompts explicitly call for domain/service/
infrastructure separation to keep business logic out of components and route handlers.

**Consequences:** Some extra indirection for a Phase-0-sized app (few real features yet), justified by
the explicit multi-phase roadmap ahead.

---

## ADR-004: Reference repositories (ApexEngine, FlowNex) — conceptual reuse only, no code copy

**Decision:** GitHub access to `tommynabo/ApexEngine` and `tommynabo/FlowNex` was available and both were
inspected (`SearchService.ts`, `DeduplicationService.ts`, `autopilot-engine.ts`,
`autopilot-processor.ts`, `SetterAgentService.ts`, `SetterFollowupService.ts`, dedup docs). No source was
copied. See `docs/REFERENCE_AUDIT.md` for the extracted lessons and rejected patterns.

**Rationale:** Prompt 0 §0.6 mandates inspection when accessible and explicitly forbids treating those
repos as anything other than references; §0.6 also lists specific anti-patterns (single giant `leads`
table, 30-day handle dedup, creator-specific fields) that must not become the new core model.

**Alternatives considered:** Skip inspection since it's optional if unavailable. Not applicable — access
was available, so inspection was mandatory per the prompt's own conditional.

**Consequences:** `DeduplicationService` in this project will be designed around
accounts/contacts/contact_points with Place ID / domain / phone / email strong signals (Prompt 1 §1.2),
not around a single `leads` table or a 30-day rolling window.

---

## ADR-005: Git initialized locally, no remote configured

**Decision:** Initialize a local git repository for the new project and commit Phase 0 work, but do not
create or push to any remote (GitHub, etc.) without explicit user instruction.

**Rationale:** Operational safety — pushing/creating remotes is a not-easily-reversible, externally
visible action outside the scope of "implement Phase 0 in the repo."

**Alternatives considered:** Leave the repo without version control entirely. Rejected — undermines the
"stable, tested, documented" phase-completion bar and makes future phase diffs harder to audit.

**Consequences:** User must explicitly set up and push to a remote when ready.

---

## ADR-006: No conflicts found between explicit non-negotiables during Phase 0

**Decision:** No contradictions were found in the master prompts document that required arbitration
between NON-NEGOTIABLES (Appendix C) and phase-specific instructions during Phase 0 execution.

**Rationale:** Documented here per Prompt 0's instruction to log any discovered conflicts, even if the
answer is "none found," so this log is a faithful audit trail.

**Alternatives considered:** N/A.

**Consequences:** None. This entry exists purely for audit completeness.

---

## ADR-007: Phase 1 Supabase schema written as unapplied SQL artifacts — no live project provisioned

**Decision:** All Prompt 1 "Supabase" deliverables (`supabase/migrations/000{1..5}_*.sql`,
`supabase/seed.sql`) are committed as version-controlled infrastructure-as-code but were **never
executed** against any live database in this session. No `mcp_supabase_*` tool was called at any point.

**Rationale:** This workspace has no Supabase project of its own (per ADR-002), so there is nothing to
apply migrations to without provisioning one first — a decision reserved for the user. Separately, this
session had working `mcp_supabase_*` tools available whose *target* project could not be verified, while
this operator's own persistent notes document a real, unrelated production Supabase project (a "Medical
CRM") with an explicit, emphatic warning after a past incident where an entire production database was
wiped with no backup. Given that risk profile, calling any `mcp_supabase_*` tool this session — even a
read-only one — was judged not worth it without first confirming which project it targets.

**Alternatives considered:** (a) Spin up a local Postgres via `initdb`/`pg_ctl` to validate the SQL
actually runs. Rejected on a time/scope tradeoff — `psql`/`initdb` are present locally but there is no
`postgres` server binary or Docker installed, and provisioning one from source was deemed out of scope
for this phase. (b) Use the available `mcp_supabase_*` tools to apply/verify the schema live. Rejected
per the safety rationale above. The SQL was instead written carefully by hand, following standard
Postgres/Supabase idioms (partial unique indexes for optional identity fields, `security definer` helper
functions for RLS, explicit `check` constraints mirroring every domain-type union).

**Consequences:** The schema is unverified against a real Postgres engine — a known limitation, called
out explicitly in `docs/PHASE_1_REPORT.md`. Before Phase 2, a real Supabase project must be provisioned
(or a local Postgres spun up) and these migrations applied and smoke-tested for the first time.

---

## ADR-008: `Account.countryCode` widened from the literal `"ES"` to `string`

**Decision:** `Account.countryCode` (introduced in Phase 0 as the literal type `"ES"`) is widened to
`string` in `src/domain/accounts/types.ts`, with an inline comment explaining why.

**Rationale:** Prompt 1 §1.9's completion criteria explicitly requires seeding an "invalid non-Spain
record," and Appendix B's `AccountStatus` state machine explicitly includes `rejected_country` as a
reachable status — meaning a non-Spain `Account` row must be representable and storable (just never
promoted past `rejected_country`) so `SpainEligibilityService`'s rejection path has real audit evidence
to point at. A literal `"ES"` type would make that seed record a type error.

**Alternatives considered:** Keep the literal `"ES"` type and represent the rejected non-Spain example
as a bare, unstructured record outside the `Account` type. Rejected — it would leave the single
most important negative-path completion criterion in §1.9 unverifiable through the actual domain model.

**Consequences:** Application code must not assume `account.countryCode === "ES"` implies eligibility —
that check belongs to `SpainEligibilityService` (`src/lib/geography/spain-eligibility.ts`), not type
narrowing. `Campaign.countryCode` (a *target* configuration field, not an evaluated fact) is intentionally
left as the literal `"ES"` in `src/domain/campaigns/types.ts` — it is not affected by this decision.

---

## ADR-009: Phase 2 discovery/enrichment providers are mock-only, no real external API calls

**Decision:** Every provider interface touched in Phase 2 (`MapsDiscoveryProvider`, `SerpDiscoveryProvider`,
`EmailVerificationProvider`) is backed exclusively by deterministic, seeded mock adapters in
`src/infrastructure/providers/*`. No real Maps/SERP/email-verification API is called anywhere this phase.

**Rationale:** Prompt 2's own scope never asked for real vendor selection or credentials, and a persistent
user-memory note independently flags an unrelated production Supabase project to treat with extreme
caution — the safest posture for an entire phase of new network-calling code is to make none of it touch
a real network path at all. Determinism (seeded hashing) also makes every engine/pipeline test
reproducible without flakiness from a live API.

**Alternatives considered:** Wire at least one real provider (e.g. a free-tier SERP API) to prove
end-to-end integration. Rejected — introduces credentials management, cost, and rate-limit flakiness for
no benefit Prompt 2 requires; real vendor selection is explicitly a business decision deferred to Phase 3
(see `docs/PROVIDERS.md` "Current status").

**Consequences:** `simulate-autopilot-day.ts` (the §2.15 integration harness) and every engine/pipeline
test run instantly and deterministically. Phase 3 must swap in real adapters behind the *same*
`domain/providers/types.ts` interfaces — no service-layer code should need to change shape when that
happens, only the concrete adapter passed in at the composition root.

---

## ADR-010: One shared `candidate-processor.ts` pipeline instead of per-engine duplication

**Decision:** All five discovery engines (`MapsFastEngine`, `MapsDeepEngine`, `GoogleSerpEngine`,
`LinkedInOwnerEngine`, `HybridFillEngine`) emit only a `RawCandidate` with an engine-specific
`rawPayload` shape (`MapsRawPayload | SerpRawPayload | LinkedInRawPayload`, a discriminated union).
A single `processRawCandidate()` function in `src/services/discovery/candidate-processor.ts` then
performs Spain eligibility → dedup → business-type classification → contact-point discovery/verification
→ ready evaluation identically for every engine.

**Rationale:** Prompt 2 §2.3's step list applies to every engine's output with only minor differences
(maps_deep reuses pre-crawled pages instead of one fresh fetch; LinkedIn never guesses a personal email).
Duplicating the ~11-step pipeline five times would create five places for the Spain-eligibility or
verification-acceptance logic to silently drift apart.

**Alternatives considered:** Give each engine its own full pipeline for maximal independence. Rejected —
directly risks the exact kind of "duplicated business logic slowly diverges" bug class this project's
architecture doc's layering rule (`services/*` implement business logic against `domain/*` types) exists
to prevent.

**Consequences:** `executeDiscovery()` on every engine is intentionally "thin" (raw-candidate-only scope
— it never itself decides readiness). `HybridFillEngine` additionally delegates to another engine's
`executeDiscovery()` and only re-tags the resulting `RawCandidate.engineType` afterward, to preserve
provenance that Hybrid Fill orchestrated that particular run without needing its own duplicate discovery
logic.

---

## ADR-011: `HybridFillEngine` delegates to other engines rather than implementing its own discovery

**Decision:** `HybridFillEngine` (`src/services/discovery/hybrid-fill-engine.ts`) holds a
`Partial<Record<EngineType, DiscoveryEngine>>` of delegate engines. Its `executeDiscovery()` looks up the
delegate matching the requested seed's `engineType`, calls that delegate's `executeDiscovery()` unchanged,
and only re-tags the resulting candidates' `engineType` to `"hybrid_fill"` before returning them.

**Rationale:** Per the master spec, Hybrid Fill's job is orchestration/fallback (broaden a category,
expand regions, deepen incomplete accounts) — the *how* of getting more candidates is always one of the
other four engines' existing logic, done under Hybrid Fill's discretion. Reimplementing Maps/SERP/LinkedIn
search logic a second time inside Hybrid Fill would violate ADR-010's rationale for the exact same reason.

**Alternatives considered:** Give `HybridFillEngine` its own provider calls. Rejected for the duplication
reason above, and because it would make `HybridFillEngine`'s behavior diverge from whichever underlying
engine it's "helping" in ways that are hard to reason about later.

**Consequences:** `HybridFillEngine.planDiscoveryBatch()` currently only delegates to `maps_fast`'s
planning (the primary hybrid-fill source per `hybrid-fill-decision.ts`'s action catalog); extending it to
delegate planning to other engine types is a straightforward, backward-compatible follow-up if a later
phase's decision logic calls for it.

---

## ADR-012: Phase 3 outreach services are mock-provider-only; the dry-run orchestrator never imports a delivery provider

**Decision:** `runOutreachDryRunCycle` (`src/services/outreach/outreach-orchestrator.ts`) composes the
`ChannelRouter`, sender pool, channel mix planner, `ComplianceGate` and message renderer, but has no
import of `EmailDeliveryProvider`/`SmsDeliveryProvider` at all — it only constructs
`OutreachQueueItem`/`OutreachEvent` records with `deliveryMode: "dry_run"` and `state: "scheduled"`.
`MockInstantlyEmailDeliveryProvider`/`MockSmsDeliveryProvider` exist as standalone, independently-tested
adapters but are not wired into the orchestrator this phase.

**Rationale:** Appendix C's non-negotiable ("real outbound disabled until go-live") is easiest to audit
when it's a structural fact (an import that doesn't exist) rather than a runtime flag check that could be
bypassed or misconfigured. A future "live" orchestrator variant is a deliberate, separate, reviewable
addition — not a branch inside this one.

**Alternatives considered:** One orchestrator with an `if (deliveryMode === "live") await provider.send()`
branch. Rejected — a single accidental config flip (or a copy-pasted test with the wrong mode) would be
enough to trigger a real send; keeping dry-run and live as structurally separate code paths raises the bar
for that mistake significantly.

**Consequences:** Enabling live sending in a later phase requires writing a new orchestrator function (or
an explicit second branch reviewed on its own merits) rather than flipping a config value in the existing
one.

---

## ADR-013: `ChannelRouter` endpoint ranking reuses Phase 1's `ContactPoint.priorityScore` instead of re-encoding the preference ladder

**Decision:** `routeAccountToEndpoint` (`src/services/outreach/channel-router.ts`) selects the eligible,
non-suppressed contact point with the highest `priorityScore` — it does not re-implement Prompt 3 §3.2's
"owner/titular > purchasing manager > manager > other named > compras@/role email > pharmacy-specific
generic > info@" ladder as a second, parallel ranking function.

**Rationale:** Phase 1's `computeStrategicPriority()` (`src/services/routing/contact-priority.ts`) already
assigns scores (100/95/90/85/80/75/65/60/50) that implement exactly this ladder. A second independent
ranking would be redundant and could silently drift out of sync with the scoring service if either one
were changed without the other.

**Alternatives considered:** A dedicated endpoint-preference comparator inside the router. Rejected as
unnecessary duplication once the existing `priorityScore` was confirmed to already encode the identical
order.

**Consequences:** Any future change to the endpoint preference order should be made once, in
`contact-priority.ts` — the router will pick it up automatically via `priorityScore` with no code change
of its own.

---

## ADR-014: One shared `ComplianceGate` implementation is consulted by both the `ChannelRouter` and the orchestrator (defense in depth)

**Decision:** `SuppressionAwareComplianceGate` (`src/services/compliance/compliance-gate.ts`) is the single
implementation of the `domain/compliance` `ComplianceGate` interface. The `ChannelRouter` independently
filters out suppressed/ineligible contact points *before* ranking candidates, and the orchestrator calls
the same gate again right before recording a queue item — so a contact can be rejected at either layer.

**Rationale:** Belt-and-suspenders: if a future change ever lets an ineligible endpoint slip past the
router's own filtering (e.g. a bug in candidate selection), the gate check immediately before "sending"
(recording, in dry-run) still catches it. This mirrors the master spec's instruction that *no send may
bypass compliance*, regardless of which upstream step selected the endpoint.

**Alternatives considered:** Check compliance only once, either in the router or only in the orchestrator.
Rejected — a single check point is a single point of failure for a rule the spec treats as non-negotiable.

**Consequences:** A test observed this directly: a suppressed contact point is filtered out by the router
itself (`no_eligible_endpoint`), so the orchestrator's own gate check never even gets the chance to reject
it for that specific case — both layers agree, which is the intended redundancy.

---

## ADR-015: The deterministic pre-router runs *before* any LLM call and its suppression result is unconditional

**Decision:** `services/setter/pre-router.ts`'s `detectDeterministicCase` is called first in
`setter-orchestrator.ts`, before the LLM/context builder is ever touched. When it matches an
unsubscribe/do-not-contact case (`suppress: true`), the orchestrator calls `addSuppression` and sets the
conversation to `"suppressed"` unconditionally — the LLM is never invoked for that reply at all, and an
existing suppression entry is also checked (via `checkSuppression`) before any LLM call for every other
reply too.

**Rationale:** Prompt 4 §4.2 is explicit: "Do not let the LLM override a suppression event." The only way
to guarantee that structurally (not just by convention) is to never give the LLM the opportunity — no
suppression decision may depend on, or be reversed by, a model call.

**Alternatives considered:** Let the LLM classify first, then check its `branch` output for `UNSUBSCRIBE`
and suppress after the fact. Rejected — this would mean an LLM output bug, prompt injection from the
reply body, or a low-confidence misclassification could result in a real unsubscribe request never being
suppressed, which is a compliance failure, not just a quality one.

**Consequences:** `simulate-setter-day.test.ts` verifies both that an unsubscribe reply never calls the
LLM provider at all (a spy wrapper asserts zero invocations) and that a *pre-existing* suppression entry
also blocks the LLM path for an otherwise-innocuous message.

---

## ADR-016: Guardrails re-validate the LLM's own output rather than trusting its self-reported `needsHuman`/`riskFlags`

**Decision:** `services/setter/guardrails.ts`'s `applyGuardrails` independently pattern-matches the
generated `draft` text against `Offer.forbiddenClaims` categories and against approved commercial/product
fact keys, and independently pattern-matches the lead's `latestIncomingMessage` for non-approved
commercial-negotiation asks — regardless of what the LLM/mock provider itself set `needsHuman`/`riskFlags`
to. `classify-and-draft.ts` always runs guardrails on a Zod-valid output before it's treated as usable.

**Rationale:** Prompt 4 §4.6 lists guardrails as hard constraints ("AI must never invent... unless
explicitly present in approved campaign knowledge"), not as suggestions to the model. A model (mock today,
real later) claiming `needsHuman: false` is not sufficient evidence that a forbidden claim wasn't made —
the system must check the actual text.

**Alternatives considered:** Trust the LLM's structured output as authoritative once it passes Zod
validation (Zod only validates shape, not content/policy compliance). Rejected — Zod cannot express "this
draft doesn't mention pricing unless the offer has approved pricing facts"; that requires a second,
independent content check.

**Consequences:** A guardrail violation always forces `needsHuman: true` and appends a risk flag, even if
the underlying `needsHuman` was `false` — tested directly in `guardrails.test.ts` and
`classify-and-draft.test.ts`.

---

## ADR-017: The autonomy policy engine is fully built and tested but has no import path to any send action

**Decision:** `services/setter/autonomy-policy.ts` exports `canAutoSend()` (a pure evaluator over branch
allowlist / confidence threshold / risk flags / contact type / campaign toggle) and the constant
`AUTO_SEND_ENABLED = false`. Neither `review-service.ts` nor `setter-orchestrator.ts` imports
`autonomy-policy.ts` — there is currently no code path in the repository that could call `canAutoSend()`
and then actually send a message without a human review action in between.

**Rationale:** Directly mirrors ADR-012's reasoning for the Phase 3 dry-run orchestrator: Prompt 4 §4.9's
"Never silently activate autosend" is far more reliably enforced as a structural fact (the function is
simply never called from a send path) than as a runtime flag that a future change could flip or bypass
by accident.

**Alternatives considered:** Wire `canAutoSend()` into `review-service.ts` behind an `if
(AUTO_SEND_ENABLED)` runtime check. Rejected for the same reason as ADR-012 — a single accidental flip of
one boolean constant, or a copy-pasted branch, would be enough to enable real autonomous sending; keeping
the policy engine entirely unwired removes that risk class.

**Consequences:** Enabling autonomy in a later phase requires writing new code that explicitly calls
`canAutoSend()` from a real send path — a deliberate, separately-reviewable change, not a config flip.

---

## ADR-018: Warm follow-up is a distinct queue/service from Phase 3's cold-sequence service, not a branch inside it

**Decision:** `services/setter/warm-followup-service.ts` (`enterWarmFollowupQueue`,
`applyWarmFollowupTrigger`, `isDueForFollowup`) is a new, independent module. It does not extend or import
`services/outreach/sequence-service.ts`'s `SequenceStepKind` (`"cold" | "warm_followup"`), even though that
type already has a `"warm_followup"` label from Phase 3.

**Rationale:** Prompt 4 §4.12 explicitly says "Do not mix this with cold follow-up state." Phase 3's
`warm_followup` step kind describes a *pre-reply* cold-outreach cadence step (still part of the original
cold sequence, just a later/softer step in it); Phase 4's warm follow-up queue is *post-reply*, for a lead
who has already responded positively and not yet booked — a conceptually different state machine with
different pause triggers (reply/meeting/unsubscribe/human-ownership vs. Phase 3's reply/bounce/unsubscribe
pausing the *cold* cadence).

**Alternatives considered:** Reuse `sequence-service.ts` and add the four Phase 4 pause triggers to its
existing `decideNextSequenceAction`. Rejected — conflating the two would make it easy to accidentally
resume cold-outreach cadence logic for a lead who has already replied and is now a Phase 4 setter
conversation, which the spec forbids.

**Consequences:** Any future feature that needs to know "is this account in cold outreach or warm
follow-up" must check both modules' state independently; there is deliberately no single combined
enum.
