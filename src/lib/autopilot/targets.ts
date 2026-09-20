import type { EngineTargetState } from "@/domain/autopilot/types";

/**
 * Pure target-model math (Prompt 0 §0.4). Deliberately does not decide
 * *how* to rebalance (that is `QuotaRebalancer` in Phase 2) — only exposes
 * the read-only arithmetic the dashboard/autopilot UI needs today, so it
 * stays correct once real rebalancing logic lands on top of it.
 */

export function sumReady(engines: readonly EngineTargetState[]): number {
  return engines.reduce((total, engine) => total + engine.readyToday, 0);
}

export function sumSoftTargets(engines: readonly EngineTargetState[]): number {
  return engines.reduce((total, engine) => total + engine.softTarget, 0);
}

export function globalDeficit(dailyTarget: number, engines: readonly EngineTargetState[]): number {
  return Math.max(0, dailyTarget - sumReady(engines));
}

/** Never counts raw discovery/queue depth as progress toward the target. */
export function engineDeficit(engine: EngineTargetState): number {
  return Math.max(0, engine.softTarget - engine.readyToday);
}

export function globalProgressPct(dailyTarget: number, engines: readonly EngineTargetState[]): number {
  if (dailyTarget <= 0) return 0;
  return Math.min(100, Math.round((sumReady(engines) / dailyTarget) * 100));
}
