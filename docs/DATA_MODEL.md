# Data Model — Vitalcap Outreach OS

This document describes the domain data model established in Phase 0 as pure TypeScript types (no database yet — that's Phase 1, where a Supabase-backed repository will implement these same shapes). It is the reference for Prompt 1 schema work.

## Core graph

```
Account ──< AccountSource            (evidence: which engine/provider discovered this account, and how)
   │
   └──< Contact ──< ContactPoint     (a named person; each has 0..N contact points — email/phone/linkedin/other)
```

An `Account` never has its identity duplicated across engines: if `maps_fast` and `google_serp` both discover "Farmacia Central Bilbao", the result is **one** `Account` with **two** `AccountSource` rows (see the `acc_5` example in `src/lib/seed/dev-seed.ts`).

## `Account` (`src/domain/accounts/types.ts`)

Key fields: `businessType` (pharmacy/parapharmacy/herbal_shop/sports_nutrition_store/supplement_store/other_retail), geographic fields (region/province/city/postalCode/address, lat/long), identity fields (`normalizedDomain`, `googlePlaceId`, `normalizedPhone`), `fitScore`/`fitTier`, and `status` — a full state machine (Appendix B):

```
discovered → normalized → deduped → country_verified → enriched → qualified → contactable → outreach_ready
```
Side states: `rejected_country`, `rejected_icp`, `duplicate_merged`, `needs_review`, `no_contact_found`, `archived`.

## `AccountSource`

One row per (account, discovering engine) pair: `sourceType` (engine), `sourceProvider` (concrete provider, e.g. `mock_maps`), `sourceExternalId`/`sourceUrl`, `rawSnapshot` (opaque provider payload for audit/debug), `discoveredAt`.

## `Contact` (`src/domain/contacts/types.ts`)

A named person tied to an `Account`. `roleType` (owner/titular_pharmacist/manager/purchasing_manager/buyer/employee/generic_role/unknown), `seniority`, `isDecisionMaker`, `sourceConfidence`, `status`.

## `ContactPoint`

A single channel endpoint (email/phone/linkedin/other) belonging to either a named `Contact` (`contactId` set) or directly to an `Account` when generic (`contactId: null`, `isGeneric: true`, e.g. `info@...`). Carries:
- `verificationStatus` (unverified/valid/catch_all/risky/invalid/unknown/disposable/bounced),
- `channelEligibility` (unknown/professional_contact/eligible_email/eligible_sms/eligible_call/consented_email/consented_sms/prior_relationship/opted_out/blocked) — **discovery is separate from eligibility**, see `docs/ARCHITECTURE.md` §6 and `domain/compliance/types.ts`,
- `priorityScore` (decision-maker named contacts outrank generic account addresses),
- full `ContactPointStatus` state machine (Appendix B).

## `Offer` / `Campaign` / `CampaignMembership` (`src/domain/campaigns/types.ts`)

`Offer` holds every commercial/product fact and claim boundary as configuration, never as code:
`approvedCommercialFacts`, `approvedProductFacts`, `approvedClaims`, `forbiddenClaims`, `faq`, `objectionGuidance`, `toneConfig`, `bookingUrl`, `primaryCta`. This is what the AI Setter (Phase 4) is allowed to reference — nothing else.

`Campaign` binds an `Offer` to one `EngineType` (`maps_fast`/`maps_deep`/`google_serp`/`linkedin_owner`/`hybrid_fill`), a `dailySoftTarget`, `autopilotEnabled`, `desiredChannelMix`, `minimumFitScore`, geography (`countryCode`), and `status` (draft/active/paused/archived). Five disabled draft campaign templates (one per engine) are pre-seeded — see `src/lib/seed/dev-seed.ts`.

## Discovery jobs (`src/domain/discovery/types.ts`)

`JobRecord<TPayload>` generic + `DiscoveryJob`/`ProcessingJob` specializations, `RawCandidate` (pre-normalization engine output), `SearchSeed`/`SearchSeedRun` (query/geography rotation bookkeeping for yield tracking), and the shared `DiscoveryEngine` interface (`validateConfig`, `planDiscoveryBatch`, `executeDiscovery`) every engine implements in Phase 2.

## Autopilot (`src/domain/autopilot/types.ts`)

`EngineTargetState` (per-engine soft target, ready-today, raw/processing queue depth, yield, provider health, next planned action), `GlobalAutopilotState` (global daily target, ready-today, sent/replies/meetings today, ready-buffer-days, system health), `RebalanceDecision` (audit log of quota reallocation between engines). See [`docs/AUTOPILOT.md`](./AUTOPILOT.md).

## Outreach (`src/domain/outreach/types.ts`)

`OutreachQueueItem`/`OutreachEvent` with a full state machine (`queued → scheduled → provider_submitted → sent → delivered → replied`, side states `failed`/`bounced`/`unsubscribed`/`canceled`/`suppressed`), `SendingDomain`/`Mailbox` (sender pool), `SuppressionEntry`/`SuppressionReason`. `DeliveryMode` is `"dry_run" | "live"`, defaulting to `dry_run` everywhere (`.env.example` → `DEFAULT_DELIVERY_MODE=dry_run`).

## Conversations / AI Setter (`src/domain/conversations/types.ts`)

`SetterBranch` catalog (INTEREST, SEND_INFO, MARGIN, PRICE, MINIMUM_ORDER, PRODUCT_DETAILS, EXISTING_SUPPLIER, SAMPLES, CREDIBILITY, NOT_DECISION_MAKER, FORWARD_TO_PURCHASING, CALL_ME_LATER, MEETING_REQUEST, LOGISTICS, COMMERCIAL_TERMS, NOT_INTERESTED, UNSUBSCRIBE, UNKNOWN, HUMAN_REQUIRED), `ConversationState` machine, `Conversation`/`ConversationMessage`/`SetterDraft`/`ReviewDecision`/`SetterFeedback`/`Meeting`. See [`docs/SETTER.md`](./SETTER.md).

## Compliance (`src/domain/compliance/types.ts`)

`ComplianceGate` interface: `ComplianceCheckInput` → `ComplianceCheckResult`, consulted before every send in every phase from Phase 3 onward.

## Not yet implemented (by design, Phase 0)

No database tables, no migrations, no RLS policies, no Supabase project. Phase 1 introduces the persisted schema (accounts/contacts/contact_points/account_sources tables + repository interfaces) behind these same domain types.

---

## Phase 1 addendum — SQL schema, RLS, dedup/eligibility/priority design

The domain types above are now backed by real (but **unapplied** — see `docs/DECISIONS.md` ADR-007) SQL
migrations under `supabase/migrations/`:

- `0001_core_schema.sql` — `workspaces`, `workspace_members`, `accounts`, `account_sources`,
  `account_merge_records`, `contacts`, `contact_points`. Strong dedup identities (`google_place_id`,
  `normalized_domain`, `normalized_phone` on accounts; `normalized_value` on contact points) are enforced
  with partial unique indexes (only when the value is present), plus supporting composite indexes for
  the name+postal-code / name+address fuzzy signals.
- `0002_campaigns_schema.sql` — `offers`, `campaigns`, `campaign_memberships`.
- `0003_jobs_schema.sql` — `discovery_jobs`, `raw_candidates`, `processing_jobs`, `outreach_queue`,
  `dead_letter_jobs`, each with the standard durable-job shape (`status`/`attempt_count`/`max_attempts`/
  `locked_at`/`locked_by`/`next_attempt_at`/`last_error`).
- `0004_outreach_conversations_schema.sql` — `outreach_events`, `conversations`,
  `conversation_messages`, `setter_drafts`, `setter_feedback`, `meetings`, `suppression_entries`.
- `0005_rls_policies.sql` — workspace-scoped RLS on every table (via an `is_workspace_member()`
  `security definer` helper, joined through the nearest ancestor that carries `workspace_id` for tables
  that don't have the column directly), plus an `audit_log` table + trigger on `account_merge_records`
  and `suppression_entries` mutations (§1.7 "audit privileged mutations").

### Deduplication (`src/services/deduplication/`)

- `account-dedup.ts` — strong signals (Place ID / domain / phone) always merge; composite/fuzzy signals
  (name+postal code / name+address / name+geo-proximity, haversine distance) only auto-merge at/above a
  configurable confidence threshold (default `0.8`), otherwise `flag_for_review`. Every merge produces an
  `AccountMergeRecord` (`merge-record.ts`).
- `contact-dedup.ts` — strong (email/phone/LinkedIn) and composite (full name + same account) contact
  matching. Distinct named contacts on the same account are never conflated.
- `outreach-dedup.ts` — suppression check first, then per-endpoint cooldown
  (`contact_point + campaign + channel`), then the account-level concurrency lock (never contact two
  endpoints of the same account simultaneously unless explicitly configured).

### Spain eligibility (`src/lib/geography/`)

`spain-provinces.ts` holds the canonical 50-province + Ceuta/Melilla dataset with postal-code prefixes.
`spain-eligibility.ts`'s `evaluateSpainEligibility()` verifies on any single strong signal (provider
country code ES / valid ES postal code / in-bounds coordinates), rejects outright on an explicit
non-Spain country code, and treats phone/domain/province-name matches as supporting-only evidence that
never verifies alone — ambiguous cases stay `needs_review`.

### Contact priority (`src/services/routing/contact-priority.ts`)

`computeStrategicPriority()` implements the §1.5 scoring table exactly (100 down to 50) and is kept
strictly separate from `verificationConfidence()` — a high-priority owner email can be technically risky,
a generic `info@` can be technically valid.

### Verification acceptance policy (`src/services/verification/acceptance-policy.ts`)

`isContactPointAcceptable()` checks a `VerificationStatus` against a campaign-configurable
`VerificationAcceptancePolicy` (default: only `valid`/`catch_all`). No provider-specific assumptions.

## Phase 2 addendum — discovery engines, enrichment, autopilot services

No schema/migration changes in Phase 2 (still unapplied to a real Postgres instance per the Phase 1
known limitation) — this phase is entirely service/engine logic layered on the existing domain types.

- **Shared candidate pipeline** (`src/services/discovery/candidate-processor.ts`): every engine's raw
  output (`MapsRawPayload | SerpRawPayload | LinkedInRawPayload`) flows through one
  `processRawCandidate()` function — Spain eligibility → account dedup → business-type classification →
  contact-point discovery (crawl/fetch → extract → verify) → role inference → strategic priority → ready
  evaluation. No engine reimplements this logic; engines only produce the raw payload shape.
- **LinkedIn Owner never guesses a personal email.** A `LinkedInRawPayload` with no
  `resolvedEmployerDomain` (i.e. no public evidence resolving the profile to a company website) produces
  zero contact points — enforced structurally by the processor, not by convention.
- **Provider usage → health**: `ProviderUsageStats` (`domain/providers/types.ts`) is accumulated per
  engine (`accumulateUsage`) and evaluated by `evaluateProviderHealth()` (error-rate + quota thresholds)
  into the existing `ProviderHealthStatus` vocabulary from Phase 0 — no new domain type needed.
- **Job queue semantics** (`infrastructure/jobs/job-queue.ts`): pure functions over the existing
  `JobRecord<TPayload>` type — atomic claim-or-skip with lease-based crash recovery, exponential backoff
  for transient errors, immediate dead-letter for permanent errors. These functions are the exact contract
  a real Supabase-backed repository (`SELECT ... FOR UPDATE SKIP LOCKED` or equivalent) must satisfy once
  Phase 1's migrations are applied for real.
- **Autopilot Target Engine services** (`src/services/autopilot/`): `PacingService`, `QuotaRebalancer`,
  `QueueHealthService` compose (via `AutopilotScheduler`) into one `runAutopilotTick()` result, all
  operating on the existing `GlobalAutopilotState`/`EngineTargetState`/`RebalanceDecision` types — no
  domain-type changes were needed for Phase 2's target-engine logic.

