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
