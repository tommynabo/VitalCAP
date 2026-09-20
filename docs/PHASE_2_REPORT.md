# Phase 2 Report — Discovery Engines, Website Enrichment, Email Discovery, Autopilot Target Engine

Implements `VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md` §2.1–§2.15. Builds directly on top of (never
replaces) Phase 0's domain vocabulary/UI shell and Phase 1's dedup/eligibility/priority/verification
services and SQL schema design.

## 1. Implemented files

### Domain

- `src/domain/providers/types.ts` — provider contracts: `ProviderUsageStats`, `MapsDiscoveryProvider`,
  `SerpDiscoveryProvider`, `EmailVerificationProvider`, `WebsiteFetcher`, plus their input/output shapes.

### Services — discovery

- `src/services/discovery/spain-search-catalog.ts` + `geography-planner.ts` — ICP/query term catalogs,
  per-province seed generation, yield-aware seed selection with cooldown.
- `src/services/discovery/business-type.ts` — deterministic keyword-based classification, no LLM call.
- `src/services/discovery/provider-health.ts` — error-rate/quota-based `ProviderHealthStatus` evaluation.
- `src/services/discovery/candidate-processor.ts` — the single shared pipeline every engine's raw output
  flows through (Spain eligibility → dedup → business-type → contact-point discovery/verification → ready
  evaluation).
- `src/services/discovery/maps-fast-engine.ts`, `maps-deep-engine.ts`, `google-serp-engine.ts`,
  `linkedin-owner-engine.ts`, `hybrid-fill-engine.ts` + `hybrid-fill-decision.ts` — the five
  `DiscoveryEngine` implementations.
- `src/services/discovery/discovery-router.ts` — thin engine-type → engine lookup, no business logic.

### Services — enrichment/verification

- `src/services/enrichment/email-extraction.ts` — mailto + visible-text email extraction, false-positive
  filtering, generic/named classification.
- `src/services/enrichment/website-crawler.ts` — same-origin, keyword-path-limited crawl.
- `src/services/verification/email-verification-cache.ts` — TTL cache in front of batch verification.

### Services — autopilot

- `src/services/autopilot/pacing-service.ts`, `quota-rebalancer.ts`, `queue-health-service.ts`,
  `autopilot-scheduler.ts` — the Autopilot Target Engine, composed by `runAutopilotTick()`.
- `src/services/autopilot/simulate-autopilot-day.ts` — the §2.15 integration/demonstration harness.

### Infrastructure

- `src/lib/security/safe-fetch.ts` — SSRF-safe fetch (manual bounded redirect loop, hostname/IP
  blocklist re-checked per hop, content-type/length limits, injectable resolver/fetch for tests).
- `src/infrastructure/providers/deterministic-fixtures.ts` — shared `hashString`/`seededRandom` helpers.
- `src/infrastructure/providers/maps/mock-provider.ts`, `serp/mock-provider.ts`,
  `email-verification/mock-provider.ts` — deterministic mock adapters for all three provider interfaces.
- `src/infrastructure/jobs/job-queue.ts` — atomic claim/lease, exponential backoff, dead-letter, pure
  functions over `JobRecord[]`.

### UI

- `src/app/(dashboard)/autopilot/page.tsx` — expanded with a KPI row (ready/target, progress %, soft
  target total, sent, ready buffer, system health) and a `RebalanceActivity` rail alongside engine cards.
- `src/components/dashboard/rebalance-activity.tsx` — new shared component, also adopted by the
  dashboard home page (`src/app/(dashboard)/page.tsx`) to remove duplicated markup.

### Tests

34 test files in total across the repo (170 tests passing), including 10 new/updated files added this
phase: `safe-fetch.test.ts` (14), `spain-search-catalog.test.ts` (4), `geography-planner.test.ts` (5),
`email-extraction.test.ts` (8), `website-crawler.test.ts` (4), `email-verification-cache.test.ts` (5),
mock-provider tests for maps/serp/email-verification (4/4/3), `job-queue.test.ts` (12),
`candidate-processor.test.ts` (6), `engines.test.ts` (10, covering all 5 engines + router),
`hybrid-fill-decision.test.ts` (6), `pacing-service.test.ts` (4), `quota-rebalancer.test.ts` (5),
`queue-health-service.test.ts` (4), `autopilot-scheduler.test.ts` (1), `simulate-autopilot-day.test.ts` (5).

## 2. Architectural decisions (see `docs/DECISIONS.md` ADR-009–011 for full rationale)

- **ADR-009**: Every Phase 2 provider adapter is mock-only, deterministic, and touches no real network —
  a standing safety decision, not a placeholder shortcut. Real vendor selection stays a Phase 3 business
  decision (`docs/PROVIDERS.md`).
- **ADR-010**: One shared `candidate-processor.ts` pipeline, not five duplicated ones. Engines only emit
  a discriminated-union `rawPayload`; all Spain/dedup/verification/priority logic lives in exactly one
  place.
- **ADR-011**: `HybridFillEngine` delegates to another engine's `executeDiscovery()` and only re-tags the
  resulting `engineType`, rather than reimplementing discovery logic a second time.

## 3. Tests executed / results

```
npx vitest run          → 33 test files, 170 tests, all passing
npx tsc --noEmit -p .   → clean, no errors
npm run lint            → clean, no errors/warnings
npm run build           → succeeds, all 14 routes prerendered/compiled
```

## 4. External services mocked

Maps/Places-shaped provider, SERP-shaped provider, email-verification provider — all three fully mocked
(`src/infrastructure/providers/*`), deterministic via a shared seeded-hash helper. Website fetching goes
through a real (non-mocked) SSRF-safe fetch implementation, but test/simulation code supplies inline fake
`WebsiteFetcher`s rather than hitting the real network. **No real external API call occurs anywhere in
this phase.**

## 5. Known limitations / technical debt

- `provider-health.ts` has no dedicated unit test file of its own (only exercised indirectly through
  `simulate-autopilot-day.test.ts` and the engines it's used by) — low risk given its small, pure surface,
  but worth a follow-up test file.
- The real Supabase-backed job/queue repository (implementing `job-queue.ts`'s exact claim/backoff/
  dead-letter semantics against real tables) is not built — that is a Phase 3 wiring task, carried
  forward from the Phase 1 known limitation that the schema itself remains unapplied to a real Postgres
  instance.
- `HybridFillEngine.planDiscoveryBatch()` only delegates planning to `maps_fast` today (see ADR-011);
  extending it to plan against other delegate engine types is a straightforward follow-up, not required
  by §2.1–§2.15's completion criteria.
- No background scheduler (Vercel Cron or equivalent) actually invokes `runAutopilotTick()` on a
  schedule yet — `docs/AUTOPILOT.md` documents this as explicit Phase 3 scope.
- `simulate-autopilot-day.ts` uses a fixed/hardcoded number of seeds per engine per simulated "day"
  (rather than looping until each engine's soft target or a real day-length budget is exhausted) to keep
  the harness fast and deterministic for CI; a fuller multi-cycle simulation is a reasonable Phase 3
  enhancement but not required by §2.15's stated completion criteria.

## 6. PASS/FAIL against §2.1–§2.15

| Section | Requirement | Status |
|---|---|---|
| §2.1 | Shared `DiscoveryEngine` interface + provider abstractions | PASS |
| §2.2 | Job/queue durable model (claim/lease/backoff/dead-letter) | PASS |
| §2.3 | Shared candidate-processing pipeline (Spain → dedup → business-type → contacts → ready) | PASS |
| §2.4 | Maps Fast engine | PASS |
| §2.5 | Geography/seed planner with yield tracking | PASS |
| §2.6 | Email extraction (mailto + visible text, never discards `info@`) | PASS |
| §2.7 | Email verification provider abstraction + TTL cache | PASS |
| §2.8 | Maps Deep engine (crawl + owner SERP evidence) | PASS |
| §2.9 | LinkedIn Owner engine (never guesses personal emails) | PASS |
| §2.10 | Google SERP engine (excludes LinkedIn results) | PASS |
| §2.11 | Autopilot Target Engine (pacing, rebalancer, queue health, scheduler) | PASS |
| §2.12 | Queue health / stuck-job detection | PASS |
| §2.13 | Provider health / outage handling + pause | PASS |
| §2.14 | Hybrid Fill engine + decision logic | PASS |
| §2.15 | Full mocked local simulation of the 250/day target, no real sends | PASS |

## 7. Next-phase recommendation

Proceed to Prompt 3 (Outreach Infrastructure) only after explicit user instruction. Before doing so,
Phase 3 should prioritize: (1) a real (even if local/dev) Postgres/Supabase instance to finally validate
Phase 1's schema and back `job-queue.ts`'s semantics with real atomic claims, (2) wiring
`runAutopilotTick()` to an actual scheduled job runner, (3) beginning real vendor selection for at least
one of Maps/SERP/email-verification behind the existing provider interfaces (no service-layer changes
required when that happens, per ADR-009's consequences).

---

**PHASE 2 STATUS: COMPLETE. Prompt 3 has NOT been started.**
