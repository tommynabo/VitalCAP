import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { WATCHDOG_QUEUE_PAUSE_REASON } from "@/services/autopilot/watchdog-pause-policy";
import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getAutopilotSettings, getAutopilotPacingState, insertRebalanceDecision } from "@/infrastructure/neon/repositories/autopilot";
import { getCampaignQueueDepth } from "@/infrastructure/neon/repositories/job-queue";
import { getWatchdogWorkspaceSignals } from "@/infrastructure/neon/repositories/watchdog-signals";
import { enqueueDiscoveryOrdersWithinDailyRawCap } from "@/infrastructure/neon/repositories/daily-raw-request-cap";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { getApifyRecoverySnapshot, getGlobalSerperSpendToday, getRecentProviderUsage, getSerperRecoveryState, getTodaySpendUsd } from "@/infrastructure/neon/repositories/provider-runs";
import { allocateEngineWork, MAX_APIFY_RECOVERY_PROBE_RAW, MAX_RAW_PER_PLANNING_WINDOW, planApifyRecoveryProbe, planningWindowKey, rerouteEngineOrders, type EnginePlanningPerformance } from "@/services/autopilot/target-planner";
import { getAutopilotEnginePerformance } from "@/infrastructure/neon/repositories/autopilot-engine-performance";
import { decideHybridFill } from "@/services/discovery/hybrid-fill-decision";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { createApifyCredentialFingerprint, getApifyAllocationHealth, evaluateProviderHealth } from "@/services/discovery/provider-health";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "@/services/discovery/spain-search-catalog";
import { getDeliveryEnv, getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { SERPER_ESTIMATED_COST_PER_QUERY_USD } from "@/infrastructure/providers/serp/serper-provider";
import type { SearchSeed } from "@/domain/discovery/types";
import { refreshWatchdogPauseForWorkspace } from "./watchdog-runner";
import { logEvent } from "@/lib/observability/structured-logger";
import { getDiscoveryBackpressureMultiplier, getProcessingHealthState } from "@/services/autopilot/watchdog-pause-policy";

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
    let settings = await getAutopilotSettings(workspaceId);
    if (settings.systemPaused && settings.systemPauseReason === WATCHDOG_QUEUE_PAUSE_REASON) {
      await refreshWatchdogPauseForWorkspace(workspaceId);
      settings = await getAutopilotSettings(workspaceId);
    }
    const effectiveState = getEffectiveAutopilotState(settings);
    if (effectiveState !== "running") {
      if (effectiveState === "paused") pausedWorkspaces += 1;
      else if (effectiveState === "system_paused") systemPausedWorkspaces += 1;
      else emergencyStoppedWorkspaces += 1;
      continue;
    }

    let processingSignals;
    let processingSignalAvailable = true;
    try {
      processingSignals = (await getWatchdogWorkspaceSignals(workspaceId))[0];
      processingSignalAvailable = Boolean(processingSignals);
    } catch {
      processingSignalAvailable = false;
    }
    const processingHealthState = processingSignalAvailable
      ? getProcessingHealthState(processingSignals!)
      : "stalled";
    const discoveryBackpressureMultiplier = processingSignalAvailable
      ? getDiscoveryBackpressureMultiplier(processingSignals!)
      : 0;
    logEvent("info", "autopilot.processing_backpressure", {
      correlationId: workspaceId,
      workspaceId,
      processingPending: processingSignals?.processingPending ?? 0,
      processingOldPending: processingSignals?.oldProcessing ?? 0,
      processingCompletedLast30M: processingSignals?.processingCompletedRecent ?? 0,
      processingFailuresLast30M: processingSignals?.processingFailedRecent ?? 0,
      processingTimedOutLast30M: processingSignals?.processingTimedOutRecent ?? 0,
      processingDrainRatePerHour: (processingSignals?.processingCompletedRecent ?? 0) * 2,
      processingHealthState,
      discoveryBackpressureMultiplier,
      watchdogPauseRequired: processingHealthState === "stalled",
    });

    const campaigns = await listAutopilotEnabledCampaigns(workspaceId);
    if (!campaigns.length) continue;
    for (const campaign of campaigns) {
      const catalog = catalogFor(campaign);
      if (catalog.length) await bootstrapSearchSeeds(campaign.id, campaign.engineType, catalog);
    }

    const pacing = await getAutopilotPacingState(workspaceId, now);
    pacingStates.push(pacing);
    campaignsTicked += campaigns.length;
    logEvent("info", "contactability.funnel_snapshot", {
      correlationId: `autopilot:${workspaceId}`,
      workspaceId,
      windowDays: 30,
      qualifiedAccounts: pacing.qualifiedAccounts,
      qualifiedWithDomain: pacing.qualifiedWithDomain,
      qualifiedWithoutValidEmail: pacing.qualifiedWithoutValidEmail,
      qualifiedDomainWithoutValidEmail: pacing.qualifiedDomainWithoutValidEmail,
      qualifiedRecoveryEligibleWithoutValidEmail: pacing.qualifiedRecoveryEligibleWithoutValidEmail,
      qualifiedTerminalNoMatchWithoutValidEmail: pacing.qualifiedTerminalNoMatchWithoutValidEmail,
      validEmailAccounts: pacing.validEmailAccounts,
      eligibleImportBacklog: pacing.eligibleImportBacklog,
      confirmedImportsToday: pacing.confirmedImportsToday,
      contactabilityHistoricalSample: pacing.contactabilityHistoricalSample,
      contactabilityImportYield: pacing.contactabilityImportYield,
      expectedImportsFromContactabilityBacklog: pacing.expectedImportsFromContactabilityBacklog,
      processingPending: pacing.processingInFlight,
      verificationPending: pacing.verificationInFlight,
    });
    logEvent("info", "maps_fast.website_recovery_outcomes", {
      correlationId: `autopilot:${workspaceId}`,
      workspaceId,
      windowDays: 30,
      ...pacing.recoveryOutcomes,
    });
    // The target and budget are workspace-wide, never multiplied by engines.
    if (pacing.remainingTarget <= 0) continue;

    const mapsEnv = getMapsEnv();
    const serperEnv = getSerperEnv();
    const serperSpendToday = await getGlobalSerperSpendToday(now);
    const serperBudgetRemaining = Math.max(0, serperEnv.SERPER_DAILY_COST_LIMIT_USD - serperSpendToday);
    const apifyRecovery = await getApifyRecoverySnapshot(workspaceId, now);
    const mapsHealth = getApifyAllocationHealth(apifyRecovery);
    const serperRecovery = await getSerperRecoveryState(now);
    const serpHealth = serperRecovery.recoveryProbeEligible
      ? "untested"
      : serperRecovery.allocationPaused
        ? "paused"
        : evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "serper", 24, serperRecovery.recoveredAt));
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
    const recoveryRawNeed = apifyRecovery.recoveryProbeEligible
      ? Math.min(MAX_APIFY_RECOVERY_PROBE_RAW, pacing.rawRequestsRemaining)
      : 0;
    const unscaledPlanningRawLimit = Math.min(
      MAX_RAW_PER_PLANNING_WINDOW,
      Math.max(Math.ceil(pacing.rawNeededToPlan), recoveryRawNeed),
    );
    const planningRawLimit = Math.floor(unscaledPlanningRawLimit * discoveryBackpressureMultiplier);
    const recoveryProbeOrders = planApifyRecoveryProbe({
      workspaceId,
      campaigns: concreteCampaigns,
      rawNeeded: planningRawLimit,
      eligible: apifyRecovery.recoveryProbeEligible,
      dailyBudgetAllowed: pacing.apifyDailyBudgetRemaining > 0,
      cooldownAt: apifyRecovery.nextRecoveryAttemptAt,
      credentialFingerprint: createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN) ?? "unconfigured",
      failureEpoch: apifyRecovery.latestFailureAt
        ? new Date(apifyRecovery.latestFailureAt).toISOString()
        : apifyRecovery.nextRecoveryAttemptAt?.toISOString() ?? "unknown",
      now,
      timeZone: settings.timezone,
    });
    if (apifyRecovery.credentialChangedSinceLatestFailure === true) {
      logEvent("info", "apify.credential_rotation_detected", {
        correlationId: workspaceId,
        workspaceId,
        recoveryProbeEligible: apifyRecovery.recoveryProbeEligible,
      });
    }
    for (const order of recoveryProbeOrders) {
      logEvent("info", "apify.recovery_probe_scheduled", {
        correlationId: `${workspaceId}:${order.campaignId}:${order.planningWindow}`,
        workspaceId,
        campaignId: order.campaignId,
        engineType: order.engineType,
        desiredRawCount: order.desiredRawCount,
      });
    }
    const recoveryProbeRaw = recoveryProbeOrders.reduce((total, order) => total + order.desiredRawCount, 0);
    let orders = allocateEngineWork({
      workspaceId, campaigns: concreteCampaigns, capabilities, performances,
      rawNeeded: planningRawLimit - recoveryProbeRaw, reason: pacing.explanation, now, timeZone: settings.timezone, origin: "normal",
    });
    for (const performance of performances) {
      const order = orders.find((item) => item.campaignId === performance.campaignId);
      logEvent("info", "autopilot.cost_efficiency", {
        correlationId: `${workspaceId}:${performance.campaignId}:${planningWindowKey(now, settings.timezone)}`,
        workspaceId,
        campaignId: performance.campaignId,
        engineType: concreteCampaigns.find((campaign) => campaign.id === performance.campaignId)?.engineType ?? null,
        sampleSize: performance.rawCount ?? 0,
        importYield: performance.importRawYield ?? null,
        costPerImport: performance.costPerConfirmedImportUsd ?? null,
        costUsd: performance.estimatedProviderCostUsd ?? null,
        batchSize: order?.desiredRawCount ?? 0,
        yieldTier: performance.yieldTier ?? "neutral_prior",
      });
    }

    // Hybrid Fill is a policy: it redirects to an alternative campaign and
    // keeps that engine's real source/metrics, avoiding duplicate accounts.
    const hybridDecisions = decideHybridFill({
      enabled: campaigns.some((campaign) => campaign.engineType === "hybrid_fill"),
      rawDeficit: Math.floor(pacing.rawNeededToPlan * discoveryBackpressureMultiplier),
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
          rawNeeded: Math.floor(pacing.rawNeededToPlan * discoveryBackpressureMultiplier),
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
    orders = [...orders, ...recoveryProbeOrders];

    const reservation = await enqueueDiscoveryOrdersWithinDailyRawCap(orders.map((order) => ({
      campaignId: order.campaignId,
      type: "run_engine_batch",
      payload: {
        engineType: order.engineType,
        desiredRawCount: order.desiredRawCount,
        planningWindow: order.planningWindow,
        reason: order.reason,
        origin: order.origin,
        ...(order.origin === "recovery_probe" ? {
          recoveryCredentialFingerprint: createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN),
        } : {}),
      },
      idempotencyKey: order.idempotencyKey,
      desiredRawCount: order.desiredRawCount,
    })), now);
    const reservedByKey = new Map(reservation.orders.map((order) => [order.idempotencyKey, order]));
    const reservedOrders = orders.flatMap((order) => {
      const reserved = reservedByKey.get(order.idempotencyKey);
      return reserved
        ? [{ ...order, desiredRawCount: reserved.desiredRawCount, rebalanceAmount: Math.min(order.rebalanceAmount ?? 0, reserved.desiredRawCount) }]
        : [];
    });
    ordersScheduled += reservedOrders.reduce((total, order) => total + order.desiredRawCount, 0);

    const remainingRebalanceByKey = new Map(reservedOrders.map((order) => [order.idempotencyKey, order.rebalanceAmount ?? 0]));
    for (const rebalance of hybridRebalances) {
      const { decision, order, amount } = rebalance;
      const remainingRebalance = remainingRebalanceByKey.get(order.idempotencyKey) ?? 0;
      const reservedAmount = Math.min(amount, remainingRebalance);
      if (reservedAmount <= 0) continue;
      remainingRebalanceByKey.set(order.idempotencyKey, remainingRebalance - reservedAmount);
      const baseKey = `hybrid:${workspaceId}:${order.engineType}:${order.campaignId}:${order.planningWindow}`;
      await insertRebalanceDecision(workspaceId, {
        fromEngine: decision.sourceEngine,
        toEngine: order.engineType,
        amount: reservedAmount,
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
