# Providers — Vitalcap Outreach OS

Per Prompt 0 §0.8, no external provider is hard-coded into the domain layer. This document tracks the intended provider interfaces, their infrastructure homes, and current (Phase 0) status.

## Implemented adapters (Phase 2 — mock only, no real API calls)

| Interface | Mock adapter | Notes |
|---|---|---|
| `MapsDiscoveryProvider` | `src/infrastructure/providers/maps/mock-provider.ts` (`MockMapsDiscoveryProvider`) | Deterministic per query+geography+page (seeded via `deterministic-fixtures.ts`), paginates up to 3 pages, ~8 results/page, website present ~75% of the time. |
| `SerpDiscoveryProvider` | `src/infrastructure/providers/serp/mock-provider.ts` (`MockSerpDiscoveryProvider`) | Detects role/LinkedIn-shaped queries via regex and emits `linkedin.com` profile results ~60% of the time for those; otherwise business-website-shaped results. |
| `EmailVerificationProvider` | `src/infrastructure/providers/email-verification/mock-provider.ts` (`MockEmailVerificationProvider`) | Deterministic code assignment (`valid`/`catch_all`/`risky`/`invalid`) via a seeded roll, always batches per `verifyBatch`. |
| `WebsiteFetcher` | `src/lib/security/safe-fetch.ts` (`safeFetchPage`) + `src/services/enrichment/website-crawler.ts` | Not a mock — a real SSRF-safe fetch implementation (manual bounded redirect loop, hostname/IP blocklist, content-type/length limits). Test/simulation code supplies inline fake `WebsiteFetcher` implementations instead of hitting the network. |

All three domain-interface mocks share `src/infrastructure/providers/deterministic-fixtures.ts` (`hashString`, `seededRandom`) so synthetic output is stable across calls/tests while still varying meaningfully by input. **No real external API is called anywhere in Phase 2** — this is a standing safety decision (see ADR log); real adapters for these same interfaces are a Phase 3 concern once business input on vendor choice (see "Current status" below) is available.

## Implemented adapters (Phase 3 — mock only, no real API calls)

| Interface | Mock adapter | Notes |
|---|---|---|
| `EmailDeliveryProvider` | `src/infrastructure/providers/instantly/mock-provider.ts` (`MockInstantlyEmailDeliveryProvider`) | Instantly-shaped `addLead`/`syncStatus`; deterministic `providerLeadId`/status-event rolls via the shared fixture pattern; no campaign ID is ever hard-coded — always supplied by the caller. |
| `SmsDeliveryProvider` | `src/infrastructure/providers/sms/mock-provider.ts` (`MockSmsDeliveryProvider`) | Deterministic segment/cost calculation from body length; deterministic status-event rolls (delivered/replied/failed/opted_out). |

`runOutreachDryRunCycle` (`src/services/outreach/outreach-orchestrator.ts`) never imports either mock provider — the dry-run orchestrator only ever records planned `OutreachQueueItem`/`OutreachEvent` rows, so a real send requires a separate, explicit live-mode code path that does not exist yet.

## Implemented adapters (Phase 4 — mock only, no real API calls)

| Interface | Mock adapter | Notes |
|---|---|---|
| `LLMProvider` | `src/infrastructure/providers/llm/mock-provider.ts` (`MockLLMProvider`) | Deterministic keyword classifier + template drafting over the whitelisted `SetterPromptContext` (never a raw DB dump); confidence rolls reuse the shared `hashString`/`seededRandom` fixture pattern; `needsHuman` is forced for `COMMERCIAL_TERMS`/`NOT_DECISION_MAKER`/`UNKNOWN`. |

Every `MockLLMProvider` response is still re-validated by `services/setter/setter-output-schema.ts` (Zod) and passed through `services/setter/guardrails.ts` before being trusted — the mock's own honesty is never assumed. `AUTO_SEND_ENABLED` (`services/setter/autonomy-policy.ts`) is a hardcoded `false` constant not read by any send path.

## Intended interfaces (Phase 5+, not yet implemented)

| Interface | Consumed by | Infrastructure home |
|---|---|---|
| `CalendarProvider` (if needed) | meeting booking confirmation | not yet allocated a folder — add under `infrastructure/providers/` when a later phase needs it |

That folder currently contains only a `README.md` documenting its future ownership — no logic, no mock implementations yet, per the instruction not to fabricate placeholder architecture beyond what's needed to name the slot.

## Rules for when these are implemented (Phase 3+)

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
