# Reference Audit — ApexEngine & FlowNex

Per Prompt 0 §0.6, both reference repositories were accessible and were inspected via GitHub before writing any code for this project. No source was copied; this document records the conceptual lessons that informed Phase 0 and will inform Phases 1–4.

Files inspected (conceptually, not copied):

**ApexEngine**: `services/deduplication/DeduplicationService.ts`, historical anti-duplicate logic, search/enrichment orchestration, pre-flight duplicate filtering before expensive processing.

**FlowNex**: `services/search/SearchService.ts`, `services/deduplication/DeduplicationService.ts`, `services/search/EmailDiscoveryService.ts`, `api/cron/autopilot-engine.ts`, `api/cron/autopilot-processor.ts`, `api/instantly-add-lead.ts`, `api/scrape-email.ts`, `api/webhooks/instantly-reply.ts`, `services/setter/SetterAgentService.ts`, `services/setter/SetterFollowupService.ts`, `api/setter/send-reply.ts`, `api/cron/setter-followup.ts`, `supabase/setter_module_schema.sql`, and the `SistemaLinkedin`/`SistemaLinkedinV2` code paths.

## Patterns worth reusing conceptually

- **Pre-flight dedup before spending provider credits.** Cheap identity checks (place ID, domain, phone, email) run before any paid enrichment/verification call — adopted as a hard requirement for the Phase 1 `DeduplicationService` and Phase 2 discovery engines.
- **A thin `SearchService` router delegating to provider-specific engines.** Matches this project's `DiscoveryEngine` interface (`src/domain/discovery/types.ts`) — one contract, N engine implementations, no per-provider branching leaking into calling code.
- **Producer/processor queue separation** (`autopilot-engine` vs `autopilot-processor`). Directly informs Prompt 0 §0.5's mandatory producers/processors architecture and the Phase 2 Autopilot Target Engine design.
- **Setter feedback + mandatory human review loop.** Matches this project's human-in-the-loop requirement (§0.1) and the `Conversation`/`ReviewDecision`/`SetterFeedback` types in `src/domain/conversations/types.ts`.
- **Idempotent reply ingestion** (webhook handler pattern in `api/webhooks/instantly-reply.ts`). Non-negotiable for Phase 3/4 — reply webhooks must be safe to receive more than once without creating duplicate conversations/events.

## Patterns to reject

- **A single giant `leads` table as the center of the data model.** Explicitly forbidden by the master prompt. This project uses a normalized `accounts` / `contacts` / `contact_points` graph plus dedicated `campaigns`, `outreach_events`, `conversations` tables (Phase 1+), not one denormalized mega-table.
- **FlowNex's creator-specific fields and 30-day handle-based dedup window.** Creator/influencer-specific columns and a rolling 30-day dedup horizon do not fit a B2B pharmacy/retail ICP where the same account may be legitimately re-approached across quarters; dedup here is identity-based (place ID/domain/phone/email), not time-window-based.
- **Hardcoded campaign IDs, prices, booking URLs, brand facts and niche-specific setter branches in source code.** All of this lives in `Offer`/`Campaign` configuration data (`src/domain/campaigns/types.ts`), never in TypeScript literals or prompt strings.
- **Authenticated/scraping-based LinkedIn access as a requirement.** `linkedin_owner` engine design relies on public search discovery only (§0.3.D).
- Some LinkedIn V2 code in FlowNex references shared files that may not exist in the current branch — treated as conceptual inspiration only, never as authoritative or directly portable.

## Migration lessons

- Adapters/providers must sit behind interfaces in `infrastructure/providers/*`, never called directly from domain or route-handler code — this avoids the tight coupling observed between FlowNex's cron handlers and specific provider SDKs.
- Compliance/eligibility must be its own layer (`ComplianceGate`, `src/domain/compliance/types.ts`) rather than inline checks scattered across delivery code, which is closer to how bounce/opt-out suppression appeared ad hoc in the reference repos.
- Background job orchestration should be a clean abstraction from day one (even if Phase 2 initially implements it with Vercel Cron), rather than cron-handler files that directly embed business logic, as seen in `api/cron/autopilot-engine.ts`.

## New architecture decision

This project's data model (Phase 1) will center on:

```
accounts ──< account_sources
   │
   └──< contacts ──< contact_points
```

with `campaigns`, `offers`, `outreach_events`, `conversations` as first-class tables of their own — not derived from or bolted onto a `leads` table. Deduplication keys on Google Place ID, normalized domain, normalized phone, and normalized email, evaluated pre-enrichment. See [`docs/DATA_MODEL.md`](./DATA_MODEL.md) for the full (Phase 1-scoped) schema plan and [`docs/DECISIONS.md`](./DECISIONS.md) ADR-004 for the decision record.
