# Autopilot — Vitalcap Outreach OS

Autopilot is the primary product (§0.2), not a manual search tool. This document covers the Phase 0 vocabulary/math already implemented and the Phase 2/5 scope not yet built.

## What exists today (Phase 0 + Phase 2)

- **Vocabulary** (`src/domain/autopilot/types.ts`): `ProviderHealthStatus`, `EngineTargetState`, `GlobalAutopilotState`, `RebalanceDecision`.
- **Pure target math** (`src/lib/autopilot/targets.ts`, tested in `targets.test.ts`): `sumReady`, `sumSoftTargets`, `globalDeficit`, `engineDeficit`, `globalProgressPct`. Deliberately contains no rebalancing decision logic — the Phase 2 services below build on top of it, unmodified.
- **`PacingService`** (`src/services/autopilot/pacing-service.ts`): `computePacing(dailyTarget, actualReady, now, window)` — linear-trajectory expected-ready calculation against an 8–20 Europe/Madrid operating window, returns `behind`/`ahead`/`on_track` plus a `suggestedBatchMultiplier`.
- **`QuotaRebalancer`** (`src/services/autopilot/quota-rebalancer.ts`): `computeRebalancing(state, now)` — for each engine behind its soft target, splits the deficit proportionally by yield across up to 2 healthy, non-paused donor engines, producing `RebalanceDecision`s with human-readable reasons matching the master spec's worked example format.
- **`QueueHealthService`** (`src/services/autopilot/queue-health-service.ts`): `evaluateQueueHealth(jobs, now)` — pending/processing/dead-letter counts, oldest-pending age, stuck-processing detection (lease expired without completion).
- **`ProviderHealthService`** logic (`src/services/discovery/provider-health.ts`, built alongside the discovery engines): `evaluateProviderHealth(usage, thresholds)` — error-rate + quota-based health verdict (`healthy`/`degraded`/`paused`/`unknown`).
- **`AutopilotScheduler`** (`src/services/autopilot/autopilot-scheduler.ts`): `runAutopilotTick(state, jobs, now)` — the single orchestration point composing pacing, rebalancing, Hybrid Fill decisions (`services/discovery/hybrid-fill-decision.ts`), and queue health into one tick result.
- **`simulate-autopilot-day.ts`** (`src/services/autopilot/`): end-to-end demonstration harness — drives all five engines' mock providers, runs candidates through the shared processor with cross-engine dedup, forces a LinkedIn Owner provider outage to exercise the paused/degraded + Hybrid Fill fallback path, exercises job-queue retry/backoff/dead-letter, and produces a ready-buffer-days figure plus one scheduler tick against the resulting state. No real sending, no real provider calls.
- **Seed state** (`src/lib/seed/dev-seed.ts`): reproduces the exact §0.4 worked example (Maps Fast 60 / Maps Deep 50 / Google SERP 63 / LinkedIn Owner 27 / Hybrid Fill 50 = 250), with LinkedIn Owner marked `degraded` and three sample `RebalanceDecision` log entries matching the master doc's example reasoning strings.
- **UI** (`/` Dashboard and `/autopilot`): renders global progress, a KPI row (ready/target, progress %, soft target total, sent, ready buffer, system health), per-engine cards, and a shared `RebalanceActivity` rail component — all against seed data, read-only.

## Target model rules (carried forward from `docs/MASTER_SPEC.md` §4)

1. Global daily target (250) is primary; the 5×50 per-engine split is a **soft** target.
2. Never force low-quality or duplicate leads to hit a starved engine's soft target — rebalance the deficit across healthy engines instead (`QuotaRebalancer`, implemented Phase 2).
3. Distinguish funnel stages strictly: raw discovered → unique accounts → contacts found → verified contacts → outreach-ready → sent → delivered → replied → positive → meeting booked → won/lost. Raw discovery volume is never counted as progress (`engineDeficit`/`globalProgressPct` only look at `readyToday`, never `rawQueueDepth`).
4. Maintain a 3–7 day ready buffer (250/day ⇒ 750–1750 outreach-ready prospects) so sending never depends on discovery being live at send time.

## Not yet implemented (Phase 3 — real scheduling wiring)

- Background job orchestration (Vercel Cron or equivalent) driving `runAutopilotTick` on a real schedule against a real Supabase-backed job table.
- Persisted job/queue tables backing `DiscoveryJob`/`ProcessingJob` (`domain/discovery/types.ts`) — today's `job-queue.ts` is pure functions over `JobRecord[]`, ready for a repository to wrap.

## Not yet implemented (Phase 5 — flagship UI)

- Target allocation visualization, dead-letter/failure warnings drawer, manual override controls, historical trend charts.
