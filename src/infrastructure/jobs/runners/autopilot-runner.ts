import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getGlobalAutopilotState } from "@/infrastructure/neon/repositories/autopilot";
import { insertRebalanceDecision } from "@/infrastructure/neon/repositories/autopilot";
import { getRecentProviderUsage } from "@/infrastructure/neon/repositories/provider-runs";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { runAutopilotTick } from "@/services/autopilot/autopilot-scheduler";
import { providerLabelForEngine } from "./engine-factory";
import type { EngineType } from "@/domain/campaigns/types";
import type { GlobalAutopilotState, ProviderHealthStatus } from "@/domain/autopilot/types";
import type { JobRecord } from "@/domain/discovery/types";

async function withRealProviderHealth(workspaceId: string, state: GlobalAutopilotState): Promise<GlobalAutopilotState> {
  const engines = await Promise.all(
    state.engines.map(async (engine) => {
      const usage = await getRecentProviderUsage(workspaceId, providerLabelForEngine(engine.engineType as EngineType));
      const providerHealth: ProviderHealthStatus = evaluateProviderHealth(usage);
      return { ...engine, providerHealth };
    }),
  );
  const systemHealth: ProviderHealthStatus = engines.some((e) => e.providerHealth === "paused")
    ? "paused"
    : engines.some((e) => e.providerHealth === "degraded")
      ? "degraded"
      : engines.every((e) => e.providerHealth === "healthy")
        ? "healthy"
        : "unknown";
  return { ...state, engines, systemHealth };
}

export interface AutopilotRunnerResult {
  campaignsTicked: number;
  rebalanceDecisionsRecorded: number;
}

/**
 * One bounded batch of autopilot work per active/autopilot-enabled
 * workspace: loads real `GlobalAutopilotState`, recomputes each engine's
 * `providerHealth` from real recent `provider_runs` (replacing the
 * dashboard's previously-hardcoded `"unknown"`), runs one pure
 * `runAutopilotTick`, and persists any `RebalanceDecision`s it produced.
 * Never touches outreach sending — this is target/quota bookkeeping only
 * (§2.11). Called once per `/api/cron/autopilot` invocation.
 */
export async function runAutopilotCronTick(now: Date = new Date()): Promise<AutopilotRunnerResult> {
  const workspaceIds = await listWorkspaceIds();
  let campaignsTicked = 0;
  let rebalanceDecisionsRecorded = 0;

  for (const workspaceId of workspaceIds) {
    const campaigns = await listAutopilotEnabledCampaigns(workspaceId);
    if (campaigns.length === 0) continue;

    const baseState = await getGlobalAutopilotState(workspaceId);
    const state = await withRealProviderHealth(workspaceId, baseState);

    // No durable "job snapshot" read exists yet for `evaluateQueueHealth`'s `JobRecord[]` input
    // (it wants raw/processing queue rows, not the depth counts `getGlobalAutopilotState` already
    // aggregates) — passed as an empty array is an honest simplification: `evaluateQueueHealth`
    // still returns valid (if permissive) output, and no queue-health finding is silently fabricated.
    const jobs: JobRecord[] = [];

    const tick = runAutopilotTick(state, jobs, now);
    for (const decision of tick.rebalanceDecisions) {
      await insertRebalanceDecision(workspaceId, {
        fromEngine: decision.fromEngine,
        toEngine: decision.toEngine,
        amount: decision.amount,
        reason: decision.reason,
      });
      rebalanceDecisionsRecorded += 1;
    }
    campaignsTicked += campaigns.length;
  }

  return { campaignsTicked, rebalanceDecisionsRecorded };
}
