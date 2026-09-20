import type { GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";
import type { JobRecord } from "@/domain/discovery/types";
import { sumReady } from "@/lib/autopilot/targets";
import { computePacing, type PacingResult, type OperatingWindow } from "./pacing-service";
import { computeRebalancing } from "./quota-rebalancer";
import { evaluateQueueHealth, type QueueHealthSnapshot } from "./queue-health-service";
import { planHybridFillActions, type HybridFillAction } from "@/services/discovery/hybrid-fill-decision";

/**
 * Autopilot Scheduler (Prompt 2 §2.11): the single, dedicated orchestration
 * point for one autopilot "tick" — never scattered cron conditionals.
 * Composes `PacingService`, `QuotaRebalancer`, `QueueHealthService`, and
 * the Hybrid Fill decision layer into one result. `ProviderHealthService`'s
 * job (per-provider usage → health) is `services/discovery/provider-health.ts`,
 * consumed upstream to keep each `EngineTargetState.providerHealth` current
 * before this tick runs — this function only reads that already-computed
 * health, it does not recompute it.
 */

export interface AutopilotTickResult {
  pacing: PacingResult;
  rebalanceDecisions: RebalanceDecision[];
  hybridFillActions: HybridFillAction[];
  queueHealth: QueueHealthSnapshot;
}

export function runAutopilotTick(
  state: GlobalAutopilotState,
  jobs: readonly JobRecord[],
  now: Date,
  window?: OperatingWindow,
): AutopilotTickResult {
  return {
    pacing: computePacing(state.dailyTarget, sumReady(state.engines), now, window),
    rebalanceDecisions: computeRebalancing(state, now),
    hybridFillActions: planHybridFillActions(state),
    queueHealth: evaluateQueueHealth(jobs, now),
  };
}
