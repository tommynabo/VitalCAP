# Providers — Vitalcap Outreach OS

Per Prompt 0 §0.8, no external provider is hard-coded into the domain layer. This document tracks the intended provider interfaces, their infrastructure homes, and current status.

## Implemented adapters (Gate D — real API calls)

| Interface | Real adapter | Notes |
|---|---|---|
| `MapsDiscoveryProvider` | `src/infrastructure/providers/maps/apify-provider.ts` (`ApifyMapsDiscoveryProvider`) | Real Apify REST calls (`src/infrastructure/providers/maps/apify-client.ts`): documented async start-run → poll → dataset-fetch pattern (§15), `maxTotalChargeUsd` batch cost guard + injected daily-spend guard (§14), defensive multi-actor field mapping (`mapApifyItemToPlaceResult`). Actor choice is registry-driven (`actor-registry.ts`, §11/§13) and must be informed by `npm run benchmark:maps` (§12) — see `docs/APIFY_ACTOR_BENCHMARK.md`. |
| `SerpDiscoveryProvider` | `src/infrastructure/providers/serp/serper-provider.ts` (`SerperDiscoveryProvider`) | Real Serper.dev `POST https://google.serper.dev/search` calls (§16), Spain country/language config, bounded timeout + retry, in-process response cache to avoid re-billing identical queries (§17). Used for both `google_serp` and `linkedin_owner` (public `site:linkedin.com/in` searches only, §18). |
| `EmailVerificationProvider` | `src/infrastructure/providers/email-verification/millionverifier-provider.ts` (`MillionVerifierEmailVerificationProvider`) | Real MillionVerifier Single API calls, bounded concurrency fan-out (no true real-time batch endpoint exists), provider errors/outages always map to `unknown` — never `valid` (§20). |

`src/infrastructure/providers/provider-factory.ts` is the composition root: reads `MAPS_PROVIDER`/`SERP_PROVIDER`/`EMAIL_VERIFICATION_PROVIDER` and returns the interface-typed mock or real adapter — engines/services never import a concrete adapter class directly.

## Implemented adapters (Phase 2 — mock only, no real API calls)

| Interface | Mock adapter | Notes |
|---|---|---|
| `MapsDiscoveryProvider` | `src/infrastructure/providers/maps/mock-provider.ts` (`MockMapsDiscoveryProvider`) | Deterministic per query+geography+page (seeded via `deterministic-fixtures.ts`), paginates up to 3 pages, ~8 results/page, website present ~75% of the time. |
| `SerpDiscoveryProvider` | `src/infrastructure/providers/serp/mock-provider.ts` (`MockSerpDiscoveryProvider`) | Detects role/LinkedIn-shaped queries via regex and emits `linkedin.com` profile results ~60% of the time for those; otherwise business-website-shaped results. |
| `EmailVerificationProvider` | `src/infrastructure/providers/email-verification/mock-provider.ts` (`MockEmailVerificationProvider`) | Deterministic code assignment (`valid`/`catch_all`/`risky`/`invalid`) via a seeded roll, always batches per `verifyBatch`. |
| `WebsiteFetcher` | `src/lib/security/safe-fetch.ts` (`safeFetchPage`) + `src/services/enrichment/website-crawler.ts` | Not a mock — a real SSRF-safe fetch implementation (manual bounded redirect loop, hostname/IP blocklist, content-type/length limits). Test/simulation code supplies inline fake `WebsiteFetcher` implementations instead of hitting the network. |

All three domain-interface mocks share `src/infrastructure/providers/deterministic-fixtures.ts` (`hashString`, `seededRandom`) so synthetic output is stable across calls/tests while still varying meaningfully by input. These mocks remain the active path whenever `MAPS_PROVIDER=mock` / `SERP_PROVIDER=mock` / `EMAIL_VERIFICATION_PROVIDER=mock` (the default, and the only allowed setting outside production) — real adapters for the same interfaces shipped in Gate D (see above) and are selected via `provider-factory.ts` once the corresponding env var is switched to the real provider name and its API key is set.

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

## Current status

- `DEFAULT_DELIVERY_MODE=dry_run` is the hardcoded-safe default in `src/lib/config/env.ts` — there is no code path today that can default to `live` sending, verified by `env.test.ts`.
- Real adapters now exist for Maps (Apify), SERP/LinkedIn Owner (Serper.dev), and email verification (MillionVerifier) — see the Gate D table above. None have been run against real credentials yet in this environment; `docs/PROVIDER_SMOKE_TESTS.md` and `docs/APIFY_ACTOR_BENCHMARK.md` track that as a pending operator action, not a completed verification.
- Still unresolved / not yet implemented (deferred to later gates, need business input or further implementation):
  1. Email delivery: real Instantly v2 adapter (Gate F) — only the mock exists today.
  2. SMS: no real vendor will ever be wired per standing product policy; `SMS_PROVIDER` is a hardcoded `"disabled"` literal.
  3. LLM: real OpenAI-backed `LLMProvider` (Gate F) — only the mock exists today.
  4. `CalendarProvider` (if needed) — not yet allocated a folder.

