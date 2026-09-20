import type { EngineType } from "@/domain/campaigns/types";
import type { GlobalAutopilotState } from "@/domain/autopilot/types";
import { globalDeficit } from "@/lib/autopilot/targets";

/**
 * Hybrid Fill *decisioning* (Prompt 2 §2.10) — the part that matters most:
 * given the current global/engine state, decide which reactive actions to
 * take and log exactly why. Deliberately pure and independent of the
 * `DiscoveryEngine` interface (which has no room for a full
 * `GlobalAutopilotState` input) so it can be unit-tested and driven
 * directly by the Autopilot Target Engine, not just through a discovery
 * job's narrow `{ seed, dryRun }` shape.
 */

export type HybridFillActionType =
  | "extra_maps_fast_seeds"
  | "broaden_retail_category"
  | "expand_google_regions"
  | "deepen_incomplete_accounts"
  | "search_owner_high_fit"
  | "retry_transient_failures"
  | "switch_healthy_provider";

export interface HybridFillAction {
  type: HybridFillActionType;
  targetEngine: EngineType;
  amount: number;
  reason: string;
}

const LOW_YIELD_THRESHOLD = 0.1;

export function planHybridFillActions(state: GlobalAutopilotState): HybridFillAction[] {
  const deficit = globalDeficit(state.dailyTarget, state.engines);
  const actions: HybridFillAction[] = [];
  const byType = new Map(state.engines.map((engine) => [engine.engineType, engine]));

  for (const engine of state.engines) {
    if (engine.providerHealth === "degraded") {
      actions.push({
        type: "retry_transient_failures",
        targetEngine: engine.engineType,
        amount: 0,
        reason: `${engine.engineType} provider is degraded — retrying transient failures before reallocating its share elsewhere.`,
      });
    }
    if (engine.providerHealth === "paused") {
      actions.push({
        type: "switch_healthy_provider",
        targetEngine: engine.engineType,
        amount: 0,
        reason: `${engine.engineType} provider is paused (out of credits or unhealthy) — routing its remaining share to a healthy alternative engine.`,
      });
    }
  }

  if (deficit <= 0) return actions;

  const mapsFast = byType.get("maps_fast");
  if (mapsFast && mapsFast.providerHealth === "healthy") {
    if (mapsFast.currentYield < LOW_YIELD_THRESHOLD) {
      actions.push({
        type: "broaden_retail_category",
        targetEngine: "maps_fast",
        amount: deficit,
        reason: `Maps Fast yield has dropped to ${mapsFast.currentYield.toFixed(2)} — broadening retail category within campaign scope instead of running more of the same exhausted seeds.`,
      });
    } else {
      const amount = Math.max(1, Math.ceil(deficit * 0.5));
      actions.push({
        type: "extra_maps_fast_seeds",
        targetEngine: "maps_fast",
        amount,
        reason: `Global deficit of ${deficit} — Maps Fast is healthy at yield ${mapsFast.currentYield.toFixed(2)}, running ${amount} extra high-yield seeds.`,
      });
    }
  }

  const googleSerp = byType.get("google_serp");
  if (googleSerp && googleSerp.providerHealth === "healthy") {
    const amount = Math.max(1, Math.ceil(deficit * 0.3));
    actions.push({
      type: "expand_google_regions",
      targetEngine: "google_serp",
      amount,
      reason: `Expanding Google SERP region/category coverage by ${amount} to help close the remaining ${deficit} deficit.`,
    });
  }

  const mapsDeep = byType.get("maps_deep");
  if (mapsDeep && mapsDeep.rawQueueDepth > 0) {
    actions.push({
      type: "deepen_incomplete_accounts",
      targetEngine: "maps_deep",
      amount: mapsDeep.rawQueueDepth,
      reason: `${mapsDeep.rawQueueDepth} accounts already have a website but no verified email — deepening those before spending on new discovery.`,
    });
  }

  const linkedinOwner = byType.get("linkedin_owner");
  if (linkedinOwner && linkedinOwner.providerHealth !== "paused") {
    const amount = Math.min(deficit, 5);
    actions.push({
      type: "search_owner_high_fit",
      targetEngine: "linkedin_owner",
      amount,
      reason: `Searching for owner/titular contacts on ${amount} high-fit accounts to help close the ${deficit} deficit.`,
    });
  }

  return actions;
}
