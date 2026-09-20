# Autopilot — Vitalcap Outreach OS

Autopilot is the primary product (§0.2), not a manual search tool. This document covers the Phase 0 vocabulary/math already implemented and the Phase 2/5 scope not yet built.

## What exists today (Phase 0)

- **Vocabulary** (`src/domain/autopilot/types.ts`): `ProviderHealthStatus`, `EngineTargetState`, `GlobalAutopilotState`, `RebalanceDecision`.
- **Pure target math** (`src/lib/autopilot/targets.ts`, tested in `targets.test.ts`): `sumReady`, `sumSoftTargets`, `globalDeficit`, `engineDeficit`, `globalProgressPct`. These deliberately contain **no rebalancing decision logic** — only the read-only arithmetic the UI needs, so it stays correct once Phase 2 layers real rebalancing on top.
- **Seed state** (`src/lib/seed/dev-seed.ts`): reproduces the exact §0.4 worked example (Maps Fast 60 / Maps Deep 50 / Google SERP 63 / LinkedIn Owner 27 / Hybrid Fill 50 = 250), with LinkedIn Owner marked `degraded` and three sample `RebalanceDecision` log entries matching the master doc's example reasoning strings.
- **UI** (`/` Dashboard and `/autopilot`): renders global progress, per-engine cards (ready/target, provider health badge, raw queue depth, yield, next planned action), and the rebalance activity rail — all against seed data, read-only.

## Target model rules (carried forward from `docs/MASTER_SPEC.md` §4)

1. Global daily target (250) is primary; the 5×50 per-engine split is a **soft** target.
2. Never force low-quality or duplicate leads to hit a starved engine's soft target — rebalance the deficit across healthy engines instead.
3. Distinguish funnel stages strictly: raw discovered → unique accounts → contacts found → verified contacts → outreach-ready → sent → delivered → replied → positive → meeting booked → won/lost. Raw discovery volume is never counted as progress (`engineDeficit`/`globalProgressPct` only look at `readyToday`, never `rawQueueDepth`).
4. Maintain a 3–7 day ready buffer (250/day ⇒ 750–1750 outreach-ready prospects) so sending never depends on discovery being live at send time.

## Not yet implemented (Phase 2 — Autopilot Target Engine)

- `AutopilotScheduler`, `TargetPlanner`, `QuotaRebalancer`, `QueueHealthService`, `ProviderHealthService`, `PacingService` — the services that actually *decide* rebalancing, pacing and provider-health transitions (today's code only models their output shape and does static arithmetic on it).
- Background job orchestration (Vercel Cron or equivalent) driving these services on a schedule.
- Persisted job/queue tables backing `DiscoveryJob`/`ProcessingJob` (`domain/discovery/types.ts`).

## Not yet implemented (Phase 5 — flagship UI)

- Full Autopilot screen beyond the current read-only engine-card preview: target allocation visualization, dead-letter/failure warnings, manual override controls, historical trend charts.
