import type { GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";
import { engineDeficit } from "@/lib/autopilot/targets";

/**
 * Quota rebalancer (Prompt 2 §2.11): per-engine soft targets exist, but the
 * global 250/day target is always more important. At each checkpoint: (1)
 * compute every engine's deficit, (2) estimate available yield among
 * healthy engines, (3) reallocate the behind engine's unmet share to
 * healthy donors, (4) spread across up to two donors to preserve source
 * diversity rather than piling everything onto one, (5) never touch
 * verification/quality thresholds to "fill numbers" — this function has no
 * ability to do that; it only ever redistributes *target* numbers.
 */

export interface RebalanceOptions {
  /** Preserve diversity: never let more than this many donor engines absorb one behind-engine's deficit. */
  maxDonors: number;
}

const DEFAULT_OPTIONS: RebalanceOptions = { maxDonors: 2 };

export function computeRebalancing(state: GlobalAutopilotState, now: Date, options: Partial<RebalanceOptions> = {}): RebalanceDecision[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const decisions: RebalanceDecision[] = [];

  const behindEngines = state.engines.filter((engine) => engineDeficit(engine) > 0);

  for (const behind of behindEngines) {
    const deficit = engineDeficit(behind);
    const donors = state.engines
      .filter((engine) => engine.engineType !== behind.engineType && engine.providerHealth !== "paused" && engine.currentYield > 0)
      .sort((a, b) => b.currentYield - a.currentYield)
      .slice(0, opts.maxDonors);
    if (donors.length === 0) continue;

    const totalYield = donors.reduce((sum, donor) => sum + donor.currentYield, 0);
    let remaining = deficit;

    donors.forEach((donor, index) => {
      const isLast = index === donors.length - 1;
      const share = isLast ? remaining : Math.min(remaining, Math.round(deficit * (donor.currentYield / totalYield)));
      if (share <= 0) return;
      remaining -= share;
      decisions.push({
        id: `rebalance_${behind.engineType}_${donor.engineType}_${now.getTime()}_${index}`,
        createdAt: now.toISOString(),
        fromEngine: behind.engineType,
        toEngine: donor.engineType,
        amount: share,
        reason: `${behind.engineType} behind target by ${deficit} — allocated +${share} to ${donor.engineType}`,
      });
    });
  }

  return decisions;
}
