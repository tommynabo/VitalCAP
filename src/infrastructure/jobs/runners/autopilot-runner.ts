import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getAutopilotSettings, getAutopilotPacingState } from "@/infrastructure/neon/repositories/autopilot";
import { enqueueDiscoveryJob } from "@/infrastructure/neon/repositories/job-queue";
import { allocateMapsFastRawNeed } from "@/services/autopilot/target-planner";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getServerEnv } from "@/lib/config/env";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { planRebalancing, type CampaignPerformance } from "@/services/autopilot/rebalancing";
import { planHybridFill } from "@/services/autopilot/hybrid-fill-planner";
import { buildHybridMapsSeedCatalog } from "@/services/discovery/spain-search-catalog";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { insertRebalanceDecision, listRebalanceDecisions } from "@/infrastructure/neon/repositories/autopilot";

export interface AutopilotRunnerResult {
  campaignsTicked: number;
  rebalanceDecisionsRecorded: number;
  pausedWorkspaces: number;
  emergencyStoppedWorkspaces: number;
  pacingStates: Array<Awaited<ReturnType<typeof getAutopilotPacingState>>>;
  ordersScheduled: number;
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
  let pausedWorkspaces = 0;
  let emergencyStoppedWorkspaces = 0;
  let ordersScheduled = 0;
  const pacingStates: AutopilotRunnerResult["pacingStates"] = [];

  for (const workspaceId of workspaceIds) {
    const settings = await getAutopilotSettings(workspaceId);
    const effectiveState = getEffectiveAutopilotState(settings);
    if (effectiveState === "paused") {
      pausedWorkspaces += 1;
      continue;
    }
    if (effectiveState === "emergency_stopped") {
      emergencyStoppedWorkspaces += 1;
      continue;
    }
    const campaigns = await listAutopilotEnabledCampaigns(workspaceId);
    if (campaigns.length === 0) continue;
    const pacing = await getAutopilotPacingState(workspaceId, now);
    pacingStates.push(pacing);
    const env = getServerEnv();
    const capabilities = buildEngineCapabilities({
      mapsProvider: env.MAPS_PROVIDER,
      serpProvider: env.SERP_PROVIDER,
      mapsFastHealth: pacing.providerHealth,
      costAllowed: pacing.apifyDailyBudgetRemaining > 0,
      campaignCounts: { maps_fast: campaigns.filter((campaign) => campaign.engineType === "maps_fast").length },
    });
    const mapsFast = capabilities.find((capability) => capability.engineType === "maps_fast");
    if (mapsFast?.available && pacing.qualifiedNeededToPlan > 0 && pacing.rawNeededToPlan > 0) {
      const seedSets = await Promise.all(campaigns.filter((campaign) => campaign.engineType === "maps_fast").map((campaign) => listSearchSeedsForCampaignEngine(campaign.id, "maps_fast")));
      const performances: CampaignPerformance[] = campaigns.filter((campaign) => campaign.engineType === "maps_fast").map((campaign, index) => {
        const seeds = seedSets[index] ?? [];
        return {
          campaignId: campaign.id,
          engineType: "maps_fast",
          recentRaw: seeds.reduce((sum, seed) => sum + seed.totalRaw, 0),
          recentQualified: seeds.reduce((sum, seed) => sum + seed.totalReady, 0),
          sampleSize: seeds.reduce((sum, seed) => sum + seed.totalRaw, 0),
          providerCostUsd: null,
          providerHealth: pacing.providerHealth,
          seedExhaustion: seeds.length ? seeds.reduce((sum, seed) => sum + seed.exhaustionScore, 0) / seeds.length : 0,
          queueDepth: 0,
          activeRuns: pacing.providerRunsInFlight,
          allocatedRaw: campaign.dailySoftTarget,
        };
      });
      const previous = await listRebalanceDecisions(workspaceId);
      const rebalanceActions = planRebalancing({ performances, uncoveredRaw: pacing.rawNeededToPlan, now, lastRebalanceAt: previous[0] ? new Date(previous[0].createdAt) : null });
      const mapsSeeds = seedSets.flat();
      const seedInventoryExhausted = mapsSeeds.length > 0 && mapsSeeds.every((seed) => seed.exhaustionScore >= 0.8);
      const rescueSignal = pacing.hoursRemaining <= 2 || pacing.estimatedYield < 0.1 || seedInventoryExhausted || mapsSeeds.length === 0;
      const rebalanceOrders = rebalanceActions.map((action) => ({
        workspaceId,
        campaignId: action.toCampaignId,
        engineType: "maps_fast" as const,
        desiredRawCount: action.amount,
        reason: action.reason,
        planningWindow: `${now.toISOString()}:rebalance`,
        idempotencyKey: `autopilot:rebalance:${workspaceId}:${action.toCampaignId}:${Math.floor(now.getTime() / 1_800_000)}`,
        origin: "rebalance" as const,
      }));
      const orders = rescueSignal
        ? []
        : rebalanceOrders.length > 0
        ? rebalanceOrders
        : allocateMapsFastRawNeed({ workspaceId, campaigns, rawNeeded: pacing.rawNeededToPlan, reason: pacing.explanation, now, timeZone: settings.timezone, origin: "normal" });
      for (const order of orders) {
        await enqueueDiscoveryJob({
          campaignId: order.campaignId,
          type: "run_engine_batch",
          payload: { engineType: order.engineType, desiredRawCount: order.desiredRawCount, planningWindow: order.planningWindow, reason: order.reason, origin: order.origin },
          idempotencyKey: order.idempotencyKey,
        });
        ordersScheduled += order.desiredRawCount;
      }
      for (const action of rebalanceActions) {
        await insertRebalanceDecision(workspaceId, {
          fromEngine: action.fromCampaignId ? "maps_fast" : null,
          toEngine: "maps_fast",
          amount: action.amount,
          reason: `${action.reason} fromCampaign=${action.fromCampaignId ?? "unallocated"} toCampaign=${action.toCampaignId} remainingDeficit=${pacing.remainingTarget}`,
          fromCampaignId: action.fromCampaignId,
          toCampaignId: action.toCampaignId,
          metricSnapshot: { remainingTarget: pacing.remainingTarget, estimatedYield: pacing.estimatedYield, providerHealth: pacing.providerHealth, score: action.score },
          idempotencyKey: `rebalance:${workspaceId}:${action.toCampaignId}:${Math.floor(now.getTime() / 1_800_000)}`,
        });
        rebalanceDecisionsRecorded += 1;
      }

      const campaign = campaigns.find((candidate) => candidate.engineType === "maps_fast");
      if (campaign) {
        let seeds = seedSets[campaigns.filter((candidate) => candidate.engineType === "maps_fast").indexOf(campaign)] ?? [];
        const hybrid = planHybridFill({
          remainingEffectiveTarget: pacing.remainingTarget,
          hoursRemaining: pacing.hoursRemaining,
          normalAllocationExhausted: rescueSignal,
          sourceUnderperformed: pacing.estimatedYield < 0.1,
          seedInventoryExhausted,
          providerHealthy: mapsFast.available,
          budgetRemaining: pacing.apifyDailyBudgetRemaining,
          onPace: pacing.status === "on_pace",
          seeds,
          campaignId: campaign.id,
          now,
        });
        if (hybrid.active) {
          await bootstrapSearchSeeds(campaign.id, "maps_fast", buildHybridMapsSeedCatalog(campaign.id));
          seeds = await listSearchSeedsForCampaignEngine(campaign.id, "maps_fast");
          const hybridOrder = allocateMapsFastRawNeed({ workspaceId, campaigns: [campaign], rawNeeded: hybrid.rawCount, reason: hybrid.reason, now, timeZone: settings.timezone, origin: "hybrid_fill" })[0];
          if (hybridOrder) {
            await enqueueDiscoveryJob({
              campaignId: hybridOrder.campaignId,
              type: "run_engine_batch",
              payload: { engineType: "maps_fast", desiredRawCount: hybridOrder.desiredRawCount, planningWindow: hybridOrder.planningWindow, reason: hybridOrder.reason, origin: "hybrid_fill", seedQuery: hybrid.seed?.query, seedGeography: hybrid.seed?.geography },
              idempotencyKey: `autopilot:hybrid_fill:${workspaceId}:${campaign.id}:${Math.floor(now.getTime() / 1_800_000)}`,
            });
            ordersScheduled += hybridOrder.desiredRawCount;
          }
        }
      }
    }
    campaignsTicked += campaigns.length;
  }

  return { campaignsTicked, rebalanceDecisionsRecorded, pausedWorkspaces, emergencyStoppedWorkspaces, pacingStates, ordersScheduled };
}
