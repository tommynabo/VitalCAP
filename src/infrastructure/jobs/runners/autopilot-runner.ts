import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getAutopilotSettings, getAutopilotPacingState, insertRebalanceDecision } from "@/infrastructure/neon/repositories/autopilot";
import { enqueueDiscoveryJob } from "@/infrastructure/neon/repositories/job-queue";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { getRecentProviderUsage } from "@/infrastructure/neon/repositories/provider-runs";
import { allocateEngineWork, type EnginePlanningPerformance } from "@/services/autopilot/target-planner";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "@/services/discovery/spain-search-catalog";
import { getMapsEnv, getSerperEnv } from "@/lib/config/env";
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

function performance(campaign: Campaign, seeds: readonly SearchSeed[]): EnginePlanningPerformance {
  const raw = seeds.reduce((sum, seed) => sum + seed.totalRaw, 0);
  const qualified = seeds.reduce((sum, seed) => sum + seed.totalReady, 0);
  return {
    campaignId: campaign.id,
    yield: raw > 0 ? qualified / raw : 0.25,
    queueDepth: 0,
    seedExhaustion: seeds.length ? seeds.reduce((sum, seed) => sum + seed.exhaustionScore, 0) / seeds.length : 0,
  };
}

/** Schedules a single global qualified-target deficit across every eligible engine. */
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
    if (pacing.remainingTarget <= 0 || pacing.qualifiedNeededToPlan <= 0 || pacing.rawNeededToPlan <= 0 || pacing.status !== "behind_pace") continue;

    const mapsEnv = getMapsEnv();
    const serperEnv = getSerperEnv();
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
      costAllowed: pacing.apifyDailyBudgetRemaining > 0,
      campaignCounts: Object.fromEntries(allTypes.map((engineType) => [engineType, campaigns.filter((campaign) => campaign.engineType === engineType).length])),
    });

    const concreteCampaigns = campaigns.filter((campaign) => campaign.engineType !== "hybrid_fill");
    const seedSets = await Promise.all(concreteCampaigns.map((campaign) => listSearchSeedsForCampaignEngine(campaign.id, campaign.engineType)));
    const performances = concreteCampaigns.map((campaign, index) => performance(campaign, seedSets[index] ?? []));
    let orders = allocateEngineWork({
      workspaceId, campaigns: concreteCampaigns, capabilities, performances,
      rawNeeded: pacing.rawNeededToPlan, reason: pacing.explanation, now, timeZone: settings.timezone, origin: "normal",
    });

    // Hybrid Fill is a policy: it redirects to an alternative campaign and
    // keeps that engine's real source/metrics, avoiding duplicate accounts.
    const hasHybridPolicy = campaigns.some((campaign) => campaign.engineType === "hybrid_fill");
    const mapsPerformance = performances.find((item) => concreteCampaigns.find((campaign) => campaign.id === item.campaignId)?.engineType === "maps_fast");
    const mapsFastAvailable = capabilities.find((capability) => capability.engineType === "maps_fast")?.available ?? false;
    if (hasHybridPolicy && (
      !mapsFastAvailable
      || (mapsPerformance?.yield ?? 0.25) < 0.1
      || (mapsPerformance?.seedExhaustion ?? 0) >= 0.8
    )) {
      const alternatives = concreteCampaigns.filter((campaign) => campaign.engineType !== "maps_fast");
      const hybridOrders = allocateEngineWork({
        workspaceId, campaigns: alternatives, capabilities, performances,
        rawNeeded: Math.min(pacing.rawNeededToPlan, 100),
        reason: "hybrid_fill: Maps Fast underperformed or exhausted; routing to a healthy configured alternative.",
        now, timeZone: settings.timezone, origin: "hybrid_fill",
      });
      const divertedCampaignIds = new Set(hybridOrders.map((order) => order.campaignId));
      orders = [...hybridOrders, ...orders.filter((order) => !divertedCampaignIds.has(order.campaignId))];
    }

    for (const order of orders) {
      await enqueueDiscoveryJob({
        campaignId: order.campaignId,
        type: "run_engine_batch",
        payload: { engineType: order.engineType, desiredRawCount: order.desiredRawCount, planningWindow: order.planningWindow, reason: order.reason, origin: order.origin },
        idempotencyKey: order.idempotencyKey,
      });
      ordersScheduled += order.desiredRawCount;
      if (order.origin === "hybrid_fill") {
        await insertRebalanceDecision(workspaceId, {
          fromEngine: "maps_fast", toEngine: order.engineType, amount: order.desiredRawCount, reason: order.reason,
          fromCampaignId: null, toCampaignId: order.campaignId,
          metricSnapshot: { remainingTarget: pacing.remainingTarget, healths },
          idempotencyKey: `hybrid:${workspaceId}:${order.engineType}:${order.campaignId}:${order.planningWindow}`,
        });
        rebalanceDecisionsRecorded += 1;
      }
    }
  }
  return { campaignsTicked, rebalanceDecisionsRecorded, pausedWorkspaces, emergencyStoppedWorkspaces, systemPausedWorkspaces, pacingStates, ordersScheduled };
}
