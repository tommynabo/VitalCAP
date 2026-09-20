# Providers — Vitalcap Outreach OS

Per Prompt 0 §0.8, no external provider is hard-coded into the domain layer. This document tracks the intended provider interfaces, their infrastructure homes, and current (Phase 0) status.

## Intended interfaces (Phase 2/3, not yet implemented)

| Interface | Consumed by | Infrastructure home |
|---|---|---|
| `MapsDiscoveryProvider` | `maps_fast`, `maps_deep` engines | `src/infrastructure/providers/maps/` |
| `SerpDiscoveryProvider` | `google_serp`, `linkedin_owner` engines | `src/infrastructure/providers/serp/` |
| `WebsiteFetcher` | `maps_deep` enrichment | `src/infrastructure/providers/` (to be added alongside maps/serp in Phase 2) |
| `EmailVerificationProvider` | contact verification workers | `src/infrastructure/providers/email-verification/` |
| `EmailDeliveryProvider` | outreach delivery workers | `src/infrastructure/providers/instantly/` (Instantly.ai per master doc's reference lessons) or equivalent |
| `SmsDeliveryProvider` | outreach delivery workers | `src/infrastructure/providers/sms/` |
| `CalendarProvider` (if needed) | meeting booking confirmation | not yet allocated a folder — add under `infrastructure/providers/` when Phase 4/5 needs it |
| `LLMProvider` | AI Setter drafting/classification | `src/infrastructure/providers/llm/` |

Each folder currently contains only a `README.md` documenting its future ownership — no logic, no mock implementations yet, per the instruction not to fabricate placeholder architecture beyond what's needed to name the slot.

## Rules for when these are implemented (Phase 2/3)

- Provider adapters live in `infrastructure/`, never called directly from `domain/` or `services/`. Services depend on the interface, not the concrete provider.
- The app must keep working in dev/demo mode with mock providers + seed data (this is what Phase 0's dev seed mode already guarantees at the UI layer).
- If a provider's API is undocumented or unavailable, build the interface + a safe mock/stub — never invent endpoints.
- Consult each provider's official documentation before implementing a real integration (no guessed endpoints/URLs).

## Current status (Phase 0)

- No provider credentials are configured. `.env.example` lists variable **names only**, grouped by the phase that will consume them (Supabase → Phase 1; cron/discovery providers → Phase 2; enrichment/verification/outreach delivery → Phase 2/3; AI Setter LLM → Phase 4).
- `DEFAULT_DELIVERY_MODE=dry_run` is the hardcoded-safe default in `src/lib/config/env.ts` — there is no code path today that can default to `live` sending, verified by `env.test.ts`.
- Unresolved external provider decisions (deferred to Phase 2/3, need business input before implementation):
  1. Which concrete Maps/Places-compatible provider and which SERP provider to use (cost/ToS tradeoffs).
  2. Which email-verification vendor.
  3. Whether Instantly.ai (referenced in FlowNex) or a different email delivery provider is preferred going forward.
  4. Which SMS provider (Spain-specific deliverability/compliance considerations).
  5. Which LLM provider/model for the AI Setter, and cost/latency budget per reply.
