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
