import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getAutopilotSettings, getAutopilotPacingState, insertRebalanceDecision } from "@/infrastructure/neon/repositories/autopilot";
import { enqueueDiscoveryJob, getCampaignQueueDepth } from "@/infrastructure/neon/repositories/job-queue";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { getRecentProviderUsage, getTodaySpendUsd } from "@/infrastructure/neon/repositories/provider-runs";
import { allocateEngineWork, rerouteEngineOrders, type EnginePlanningPerformance } from "@/services/autopilot/target-planner";
import { getAutopilotEnginePerformance } from "@/infrastructure/neon/repositories/autopilot-engine-performance";
import { decideHybridFill } from "@/services/discovery/hybrid-fill-decision";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "@/services/discovery/spain-search-catalog";
import { getDeliveryEnv, getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { SERPER_ESTIMATED_COST_PER_QUERY_USD } from "@/infrastructure/providers/serp/serper-provider";
import type { SearchSeed } from "@/domain/discovery/types";

export interface AutopilotRunnerResult {
  campaignsTicked: number;
  rebalanceDecisionsRecorded: number;
  pausedWorkspaces: number;
  emergencyStoppedWorkspaces: number;
  systemPausedWorkspaces: number;
  pacingStates: Array<Awaited<ReturnType<typeof getAutopilotPacingState>>>;
  ordersScheduled: number;
}

function catalogFor(campaign: Campaign): SearchSeed[] {
  if (campaign.engineType === "maps_fast" || campaign.engineType === "maps_deep") return buildMapsSeedCatalog(campaign.id, campaign.engineType);
  if (campaign.engineType === "google_serp") return buildSerpSeedCatalog(campaign.id, "google_serp", ICP_CATEGORY_TERMS);
  if (campaign.engineType === "linkedin_owner") return buildSerpSeedCatalog(campaign.id, "linkedin_owner", LINKEDIN_OWNER_ROLE_QUERIES);
  return [];
}

function weakestHealth(...health: ProviderHealthStatus[]): ProviderHealthStatus {
  if (health.includes("paused")) return "paused";
  if (health.includes("degraded")) return "degraded";
  if (health.includes("unknown")) return "unknown";
  if (health.includes("untested")) return "untested";
  return "healthy";
}

function engineHealths(maps: ProviderHealthStatus, serp: ProviderHealthStatus): Partial<Record<EngineType, ProviderHealthStatus>> {
  return {
    maps_fast: maps,
    maps_deep: weakestHealth(maps, serp),
    google_serp: serp,
    linkedin_owner: serp,
    hybrid_fill: maps === "healthy" || serp === "healthy" || maps === "untested" || serp === "untested" ? "healthy" : weakestHealth(maps, serp),
  };
}

/** Schedules a single global target deficit across every eligible engine. */
export async function runAutopilotCronTick(now: Date = new Date()): Promise<AutopilotRunnerResult> {
  const workspaceIds = await listWorkspaceIds();
  let campaignsTicked = 0;
  let rebalanceDecisionsRecorded = 0;
  let pausedWorkspaces = 0;
  let emergencyStoppedWorkspaces = 0;
  let systemPausedWorkspaces = 0;
  let ordersScheduled = 0;
  const pacingStates: AutopilotRunnerResult["pacingStates"] = [];

  for (const workspaceId of workspaceIds) {
    const settings = await getAutopilotSettings(workspaceId);
    const effectiveState = getEffectiveAutopilotState(settings);
    if (effectiveState !== "running") {
      if (effectiveState === "paused") pausedWorkspaces += 1;
      else if (effectiveState === "system_paused") systemPausedWorkspaces += 1;
      else emergencyStoppedWorkspaces += 1;
      continue;
    }

    const campaigns = await listAutopilotEnabledCampaigns(workspaceId);
    if (!campaigns.length) continue;
    for (const campaign of campaigns) {
      const catalog = catalogFor(campaign);
      if (catalog.length) await bootstrapSearchSeeds(campaign.id, campaign.engineType, catalog);
    }

    const pacing = await getAutopilotPacingState(workspaceId, now);
    pacingStates.push(pacing);
    campaignsTicked += campaigns.length;
    // The target and budget are workspace-wide, never multiplied by engines.
    if (pacing.remainingTarget <= 0 || pacing.targetNeededToPlan <= 0 || pacing.rawNeededToPlan <= 0 || pacing.status !== "behind_pace") continue;

    const mapsEnv = getMapsEnv();
    const serperEnv = getSerperEnv();
    const serperSpendToday = await getTodaySpendUsd(workspaceId, "serper", settings.timezone, now);
    const serperBudgetRemaining = Math.max(0, serperEnv.SERPER_DAILY_COST_LIMIT_USD - serperSpendToday);
    const mapsHealth = evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "apify"));
    const serpHealth = evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "serper"));
    const healths = engineHealths(mapsHealth, serpHealth);
    const allTypes: EngineType[] = ["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"];
    const capabilities = buildEngineCapabilities({
      mapsProvider: mapsEnv.MAPS_PROVIDER,
      mapsProviderConfigured: Boolean(mapsEnv.APIFY_API_TOKEN),
      serpProvider: serperEnv.SERP_PROVIDER,
      serpProviderConfigured: Boolean(serperEnv.SERPER_API_KEY),
      mapsFastHealth: mapsHealth,
      providerHealth: healths,
      costAllowed: pacing.apifyDailyBudgetRemaining > 0 || serperBudgetRemaining >= SERPER_ESTIMATED_COST_PER_QUERY_USD,
      mapsCostAllowed: pacing.apifyDailyBudgetRemaining > 0,
      serperCostAllowed: serperBudgetRemaining >= SERPER_ESTIMATED_COST_PER_QUERY_USD,
      campaignCounts: Object.fromEntries(allTypes.map((engineType) => [engineType, campaigns.filter((campaign) => campaign.engineType === engineType).length])),
    });

    const concreteCampaigns = campaigns.filter((campaign) => campaign.engineType !== "hybrid_fill");
    const seedSets = await Promise.all(concreteCampaigns.map((campaign) => listSearchSeedsForCampaignEngine(campaign.id, campaign.engineType)));
    const enginePerformanceByCampaign = await getAutopilotEnginePerformance(workspaceId, getDeliveryEnv().INSTANTLY_CAMPAIGN_ID, now);
    const performances: EnginePlanningPerformance[] = await Promise.all(concreteCampaigns.map(async (campaign, index) => {
      const measured = enginePerformanceByCampaign.get(campaign.id);
      return {
        campaignId: campaign.id,
        yield: measured?.yield ?? 0.1,
        yieldTier: measured?.yieldTier ?? "neutral_prior",
        rawCount: measured?.rawCount ?? 0,
        confirmedImportCount: measured?.confirmedImportCount ?? 0,
        importRawYield: measured?.importRawYield ?? null,
        estimatedProviderCostUsd: measured?.estimatedProviderCostUsd ?? null,
        costPerConfirmedImportUsd: measured?.costPerConfirmedImportUsd ?? null,
        queueDepth: await getCampaignQueueDepth(campaign.id),
        seedExhaustion: seedSets[index]?.length
          ? seedSets[index].reduce((sum, seed) => sum + seed.exhaustionScore, 0) / seedSets[index].length
          : 0,
      };
    }));
    let orders = allocateEngineWork({
      workspaceId, campaigns: concreteCampaigns, capabilities, performances,
      rawNeeded: pacing.rawNeededToPlan, reason: pacing.explanation, now, timeZone: settings.timezone, origin: "normal",
    });

    // Hybrid Fill is a policy: it redirects to an alternative campaign and
    // keeps that engine's real source/metrics, avoiding duplicate accounts.
    const hybridDecisions = decideHybridFill({
      enabled: campaigns.some((campaign) => campaign.engineType === "hybrid_fill"),
      rawDeficit: pacing.rawNeededToPlan,
      candidates: concreteCampaigns.map((campaign) => {
        const capability = capabilities.find((item) => item.engineType === campaign.engineType);
        const measured = performances.find((item) => item.campaignId === campaign.id);
        return {
          campaignId: campaign.id,
          engineType: campaign.engineType,
          eligible: campaign.status === "active" && campaign.autopilotEnabled && campaign.dailySoftTarget > 0,
          available: Boolean(capability?.available),
          providerHealthy: Boolean(capability?.providerHealthy),
          yield: measured?.yield ?? 0.1,
          queueDepth: measured?.queueDepth ?? 0,
          seedExhaustion: measured?.seedExhaustion ?? 0,
        };
      }),
    });
    const hybridRebalances: Array<{ decision: (typeof hybridDecisions)[number]; order: (typeof orders)[number]; amount: number }> = [];
    if (hybridDecisions.length) {
      for (const decision of hybridDecisions) {
        const previousRebalance = new Map(orders.map((order) => [order.campaignId, order.rebalanceAmount ?? 0]));
        orders = rerouteEngineOrders({
          workspaceId, campaigns: concreteCampaigns, capabilities, performances, orders,
          rawNeeded: pacing.rawNeededToPlan,
          reason: decision.reason,
          now, timeZone: settings.timezone,
          fromCampaignIds: [decision.sourceCampaignId],
          alternativeCampaignIds: decision.destinationCampaignIds,
        });
        for (const order of orders) {
          const amount = (order.rebalanceAmount ?? 0) - (previousRebalance.get(order.campaignId) ?? 0);
          if (amount > 0) hybridRebalances.push({ decision, order, amount });
        }
      }
    }

    for (const order of orders) {
      await enqueueDiscoveryJob({
        campaignId: order.campaignId,
        type: "run_engine_batch",
        payload: { engineType: order.engineType, desiredRawCount: order.desiredRawCount, planningWindow: order.planningWindow, reason: order.reason, origin: order.origin },
        idempotencyKey: order.idempotencyKey,
      });
      ordersScheduled += order.desiredRawCount;
    }
    for (const rebalance of hybridRebalances) {
      const { decision, order, amount } = rebalance;
      const baseKey = `hybrid:${workspaceId}:${order.engineType}:${order.campaignId}:${order.planningWindow}`;
      await insertRebalanceDecision(workspaceId, {
        fromEngine: decision.sourceEngine,
        toEngine: order.engineType,
        amount,
        reason: decision.reason,
        fromCampaignId: decision.sourceCampaignId,
        toCampaignId: order.campaignId,
        metricSnapshot: {
          remainingTarget: pacing.remainingTarget,
          globalRawDeficit: pacing.rawNeededToPlan,
          healths,
          decision,
          enginePerformance: performances,
        },
        idempotencyKey: decision.sourceEngine === "maps_fast" ? baseKey : `${baseKey}:${decision.sourceCampaignId}`,
      });
      rebalanceDecisionsRecorded += 1;
    }
  }
  return { campaignsTicked, rebalanceDecisionsRecorded, pausedWorkspaces, emergencyStoppedWorkspaces, systemPausedWorkspaces, pacingStates, ordersScheduled };
}
