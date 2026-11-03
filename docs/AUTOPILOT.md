# Autopilot — Vitalcap Outreach OS

Autopilot is the primary product, not a manual search tool. This document describes the implemented runtime; the early Phase 0/2/5 descriptions below have been superseded by the production-wired runners and cron routes.

## Current Runtime

- **Planning** (`src/infrastructure/jobs/runners/autopilot-runner.ts`): ticks workspaces, respects pause/emergency states, uses watchdog queue health for discovery backpressure, calculates workspace-wide target deficit, and accounts for in-flight work.
- **Allocation and pacing**: distributes bounded work across eligible campaigns using provider health, yield, queue depth, seed exhaustion, spend caps, and economic pacing. `hybrid_fill` reroutes orders to available concrete engines; it is not an independent provider.
- **Durable execution**: discovery, processing, and verification use Neon-backed jobs and separate cron runners. Discovery supports asynchronous provider ingestion; watchdog and provider-run jobs monitor stuck or degraded work.
- **Email verification** (`src/infrastructure/jobs/runners/verification-runner.ts`): the protected verification cron enqueues eligible work, claims jobs, calls the configured provider, persists results through the Neon verification cache, and updates compliance/readiness state.
- **Compliance**: suppression, verification status, channel eligibility, and persisted compliance decisions gate outreach readiness. Unknown eligibility is not treated as permission to send.
- **Cron schedule**: `vercel.json` configures autopilot every 30 minutes, discovery every 15 minutes, processing and verification every 5/10 minutes respectively, plus provider polling and watchdog jobs.
- **UI and controls**: the dashboard and Autopilot surfaces are connected to the operational API; emergency stop and workspace pause states are enforced by the runners.

## Activation Limits

- **Outbound is not live**: the latest Phase 8Q report states `DRY_RUN` and Instantly disabled. Do not infer real sending from discovery or readiness passing.
- **Live verification remains an operational gate**: Phase 8Q reports the verification queue and adapter as passing but live provider verification as deferred. Run a controlled provider smoke test and confirm environment configuration before relying on live verification.
- **Targets and spend caps are environment-specific**: Phase 8N's target of 5/day and raw cap of 15 were activation-test settings, not universal production defaults.

## Documentation History

The Phase 8Q audit's original gap list predates the current verification implementation: the runner, cron route, Neon queue, and database cache now exist. Treat that list as a historical snapshot; the Phase 8Q report still correctly records live verification as deferred.

## Target model rules (carried forward from `docs/MASTER_SPEC.md` §4)

1. Global daily target (250) is primary; the 5×50 per-engine split is a **soft** target.
2. Never force low-quality or duplicate leads to hit a starved engine's soft target — rebalance the deficit across healthy engines instead (`QuotaRebalancer`, implemented Phase 2).
3. Distinguish funnel stages strictly: raw discovered → unique accounts → contacts found → verified contacts → outreach-ready → sent → delivered → replied → positive → meeting booked → won/lost. Raw discovery volume is never counted as progress (`engineDeficit`/`globalProgressPct` only look at `readyToday`, never `rawQueueDepth`).
4. Maintain a 3–7 day ready buffer (250/day ⇒ 750–1750 outreach-ready prospects) so sending never depends on discovery being live at send time.

## Remaining Go-Live Work

- Complete and record a live email-verification smoke test with the production provider configuration.
- Keep outbound in dry-run until delivery credentials, compliance policy, and a deliberately bounded live canary are separately approved and verified.
- Refresh phase reports when operational state changes so historical audits are not mistaken for current implementation status.
