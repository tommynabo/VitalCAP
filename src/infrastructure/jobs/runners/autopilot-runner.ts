import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { WATCHDOG_QUEUE_PAUSE_REASON } from "@/services/autopilot/watchdog-pause-policy";
import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getAutopilotSettings, getAutopilotPacingState, insertRebalanceDecision } from "@/infrastructure/neon/repositories/autopilot";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";
import { getMultiNicheCampaignInventory } from "@/infrastructure/neon/repositories/multi-niche-rollout";
import { getCampaignQueueDepth } from "@/infrastructure/neon/repositories/job-queue";
import { getWatchdogWorkspaceSignals } from "@/infrastructure/neon/repositories/watchdog-signals";
import { enqueueDiscoveryOrdersWithinDailyRawCap } from "@/infrastructure/neon/repositories/daily-raw-request-cap";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { getApifyRecoverySnapshot, getGlobalSerperSpendToday, getLatestProviderEconomicPacingStates, getRecentProviderUsage, getSerperRecoveryState, getTodaySpendUsd, recordProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { allocateEngineWork, MAX_APIFY_RECOVERY_PROBE_RAW, MAX_RAW_PER_PLANNING_WINDOW, planApifyRecoveryProbe, planningWindowKey, rerouteEngineOrders, resolveOperationalEnvelope, routeCampaignsToAvailableEngines, type EnginePlanningPerformance } from "@/services/autopilot/target-planner";
import { autopilotEnginePerformanceKey, getAutopilotEnginePerformance } from "@/infrastructure/neon/repositories/autopilot-engine-performance";
import { decideHybridFill } from "@/services/discovery/hybrid-fill-decision";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { createApifyCredentialFingerprint, getApifyAllocationHealth, evaluateProviderHealth } from "@/services/discovery/provider-health";
import { buildCampaignSeedCatalog, buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "@/services/discovery/spain-search-catalog";
import { getNicheId } from "@/services/discovery/niche-profiles";
import { getDeliveryEnv, getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
import { MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS, getMultiNicheRolloutEntry } from "@/services/autopilot/multi-niche-rollout";
import { getDayBounds } from "@/lib/time/day-bounds";
import { SERPER_ESTIMATED_COST_PER_QUERY_USD } from "@/infrastructure/providers/serp/serper-provider";
import type { SearchSeed } from "@/domain/discovery/types";
import { refreshWatchdogPauseForWorkspace } from "./watchdog-runner";
import { logEvent } from "@/lib/observability/structured-logger";
import { getDiscoveryBackpressureMultiplier, getProcessingHealthState } from "@/services/autopilot/watchdog-pause-policy";
import { computeProviderBudgetPacing, projectEndOfDayImports } from "@/services/autopilot/economic-pacing";
import { getPilotControlState } from "@/infrastructure/neon/repositories/pilot-control";

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
  const niche = getNicheId(campaign.engineConfig?.niche);
  if (niche) return buildCampaignSeedCatalog(campaign.id, campaign.engineType, niche);
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
  if ((await getPilotControlState()).status === "active") {
    return {
      campaignsTicked: 0,
      rebalanceDecisionsRecorded: 0,
      pausedWorkspaces: 0,
      emergencyStoppedWorkspaces: 0,
      systemPausedWorkspaces: 0,
      pacingStates: [],
      ordersScheduled: 0,
    };
  }
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

    if (processingSignals && processingSignals.oldDueDiscovery > 0) {
      logEvent("info", "autopilot.discovery_backlog_drain", {
        correlationId: workspaceId,
        workspaceId,
        oldDueDiscovery: processingSignals.oldDueDiscovery,
        recoverableOldDueDiscovery: processingSignals.recoverableOldDueDiscovery,
      });
      continue;
    }

    const campaigns = await listAutopilotEnabledCampaigns(workspaceId);
    if (!campaigns.length) continue;
    const rolloutCampaigns = campaigns.filter((campaign) => {
      const entry = getMultiNicheRolloutEntry(campaign.id);
      return entry !== null && entry.niche === campaign.engineConfig?.niche;
    });
    const legacyCampaigns = campaigns.filter((campaign) => !rolloutCampaigns.some((rollout) => rollout.id === campaign.id));
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
    if (pacing.remainingTarget <= 0 && rolloutCampaigns.length === 0) {
      logEvent("info", "autopilot.target_reached_stop", {
        correlationId: `autopilot:${workspaceId}`,
        workspaceId,
        targetMetric: pacing.targetMetric,
        confirmedImportsToday: pacing.confirmedImportsToday,
        remainingTarget: 0,
        processingPending: pacing.processingInFlight,
        verificationPending: pacing.verificationInFlight,
      });
      continue;
    }

    const mapsEnv = getMapsEnv();
    const serperEnv = getSerperEnv();
    const serperSpendToday = await getGlobalSerperSpendToday(now, undefined, settings.timezone);
    const serperBudgetRemaining = Math.max(0, serperEnv.SERPER_DAILY_COST_LIMIT_USD - serperSpendToday);
    const apifyDailyCap = Math.min(mapsEnv.APIFY_DAILY_COST_LIMIT_USD, settings.maxDailyApifySpendUsd ?? Number.POSITIVE_INFINITY);
    const latestEconomicPacing = await getLatestProviderEconomicPacingStates(workspaceId, settings.timezone, now);
    const apifyEconomicPacing = computeProviderBudgetPacing({
      spendTodayUsd: Math.max(0, apifyDailyCap - pacing.apifyDailyBudgetRemaining),
      dailyCapUsd: apifyDailyCap,
      elapsedOperatingFraction: pacing.elapsedOperatingFraction,
      previousState: latestEconomicPacing.apify,
    });
    const serperEconomicPacing = computeProviderBudgetPacing({
      spendTodayUsd: serperSpendToday,
      dailyCapUsd: serperEnv.SERPER_DAILY_COST_LIMIT_USD,
      elapsedOperatingFraction: pacing.elapsedOperatingFraction,
      previousState: latestEconomicPacing.serper,
    });
    for (const [provider, current, previous] of [
      ["apify", apifyEconomicPacing, latestEconomicPacing.apify],
      ["serper", serperEconomicPacing, latestEconomicPacing.serper],
    ] as const) {
      if (current.state === previous) continue;
      await recordProviderRun({
        workspaceId,
        provider,
        operation: "economic_pacing_state",
        status: "completed",
        itemsRequested: 0,
        itemsReturned: 0,
        costUsd: 0,
        metadata: {
          economicPaceState: current.state,
          spendTodayUsd: current.spendTodayUsd,
          dailyCapUsd: current.dailyCapUsd,
          expectedSpendByNowUsd: current.expectedSpendByNowUsd,
          timePacePct: current.timePacePct,
        },
      });
    }
    logEvent("info", "autopilot.economic_provider_pacing", {
      correlationId: `autopilot:${workspaceId}`,
      workspaceId,
      confirmedImportsToday: pacing.confirmedImportsToday,
      targetImports: settings.globalDailyTarget,
      remainingTarget: pacing.remainingTarget,
      elapsedOperatingFraction: pacing.elapsedOperatingFraction,
      apifySpendTodayUsd: apifyEconomicPacing.spendTodayUsd,
      apifyDailyCapUsd: apifyEconomicPacing.dailyCapUsd,
      apifyExpectedSpendByNowUsd: apifyEconomicPacing.expectedSpendByNowUsd,
      apifyPaceState: apifyEconomicPacing.state,
      apifyDiscoveryMultiplier: apifyEconomicPacing.discoveryMultiplier,
      serperSpendTodayUsd: serperEconomicPacing.spendTodayUsd,
      serperDailyCapUsd: serperEconomicPacing.dailyCapUsd,
      serperExpectedSpendByNowUsd: serperEconomicPacing.expectedSpendByNowUsd,
      serperPaceState: serperEconomicPacing.state,
      serperDiscoveryMultiplier: serperEconomicPacing.discoveryMultiplier,
      processingPending: pacing.processingInFlight,
      verificationPending: pacing.verificationInFlight,
    });
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
      mapsCostAllowed: pacing.apifyDailyBudgetRemaining > 0 && apifyEconomicPacing.discoveryMultiplier > 0,
      serperCostAllowed: serperBudgetRemaining >= SERPER_ESTIMATED_COST_PER_QUERY_USD && serperEconomicPacing.discoveryMultiplier > 0,
      campaignCounts: Object.fromEntries(allTypes.map((engineType) => [engineType,
        campaigns.filter((campaign) => campaign.engineType === engineType).length
          + (engineType === "google_serp" ? campaigns.filter((campaign) => campaign.engineType === "maps_fast").length : 0),
      ])),
    });

    const concreteCampaigns = campaigns.filter((campaign) => campaign.engineType !== "hybrid_fill");
    const legacyConcreteCampaigns = legacyCampaigns.filter((campaign) => campaign.engineType !== "hybrid_fill");
    const performanceEngineTypesByCampaign = concreteCampaigns.map((campaign) => campaign.engineType === "maps_fast"
      ? [campaign.engineType, "google_serp" as const]
      : [campaign.engineType]);
    const seedSets = await Promise.all(concreteCampaigns.flatMap((campaign, index) =>
      performanceEngineTypesByCampaign[index]!.map((engineType) => listSearchSeedsForCampaignEngine(campaign.id, engineType)),
    ));
    const seedSetsByCampaignEngine = new Map<string, typeof seedSets[number]>();
    let seedSetIndex = 0;
    concreteCampaigns.forEach((campaign, index) => {
      for (const engineType of performanceEngineTypesByCampaign[index]!) {
        seedSetsByCampaignEngine.set(autopilotEnginePerformanceKey(campaign.id, engineType), seedSets[seedSetIndex++] ?? []);
      }
    });
    const enginePerformanceByCampaign = await getAutopilotEnginePerformance(workspaceId, now);
    const recentImportSample = [...enginePerformanceByCampaign.values()]
      .reduce((total, performance) => total + performance.confirmedImportCount, 0);
    const recentRawSample = [...enginePerformanceByCampaign.values()]
      .reduce((total, performance) => total + performance.rawCount, 0);
    const attributedProviderCostUsd = [...enginePerformanceByCampaign.values()]
      .reduce((total, performance) => total + (performance.estimatedProviderCostUsd ?? 0), 0);
    const importProjection = projectEndOfDayImports({
      confirmedImports: pacing.confirmedImportsToday,
      dailyTarget: pacing.dailyTarget,
      elapsedOperatingFraction: pacing.elapsedOperatingFraction,
      recentImportsPerDay: recentImportSample / 7,
      recentImportSample,
      expectedImportsFromBacklog: pacing.expectedImportsFromBacklog,
    });
    logEvent("info", "autopilot.economic_acceptance_snapshot", {
      correlationId: `autopilot:${workspaceId}`,
      workspaceId,
      targetMetric: pacing.targetMetric,
      confirmedImportsToday: pacing.confirmedImportsToday,
      targetImports: pacing.dailyTarget,
      remainingTarget: pacing.remainingTarget,
      targetProgressPct: pacing.dailyTarget > 0 ? Math.min(100, pacing.confirmedImportsToday / pacing.dailyTarget * 100) : 0,
      rawSample7d: recentRawSample,
      confirmedImportSample7d: recentImportSample,
      rawToConfirmedImportYield7d: recentRawSample > 0 ? recentImportSample / recentRawSample : null,
      attributedProviderCost7dUsd: attributedProviderCostUsd,
      attributedProviderCostPerConfirmedImport7dUsd: recentImportSample > 0 ? attributedProviderCostUsd / recentImportSample : null,
      projectedEndOfDayImportsLow: importProjection.low,
      projectedEndOfDayImportsBase: importProjection.base,
      projectedEndOfDayImportsHigh: importProjection.high,
      processingPending: pacing.processingInFlight,
      verificationPending: pacing.verificationInFlight,
      qualifiedContactabilityBacklog: pacing.qualifiedContactabilityBacklog,
      expectedImportsFromBacklog: pacing.expectedImportsFromBacklog,
    });
    const performances: EnginePlanningPerformance[] = await Promise.all(concreteCampaigns.flatMap((campaign, index) =>
      performanceEngineTypesByCampaign[index]!.map(async (engineType) => {
        const measured = enginePerformanceByCampaign.get(autopilotEnginePerformanceKey(campaign.id, engineType));
        const engineSeeds = seedSetsByCampaignEngine.get(autopilotEnginePerformanceKey(campaign.id, engineType)) ?? [];
        return {
          campaignId: campaign.id,
          engineType,
          yield: measured?.yield ?? 0.1,
          yieldTier: measured?.yieldTier ?? "neutral_prior",
          rawCount: measured?.rawCount ?? 0,
          confirmedImportCount: measured?.confirmedImportCount ?? 0,
          importRawYield: measured?.importRawYield ?? null,
          estimatedProviderCostUsd: measured?.estimatedProviderCostUsd ?? null,
          costPerConfirmedImportUsd: measured?.costPerConfirmedImportUsd ?? null,
          queueDepth: await getCampaignQueueDepth(campaign.id),
          seedExhaustion: engineSeeds.length
            ? engineSeeds.reduce((sum, seed) => sum + seed.exhaustionScore, 0) / engineSeeds.length
            : 0,
        };
      }),
    ));
    const allocationCampaigns = routeCampaignsToAvailableEngines(concreteCampaigns, capabilities, performances);
    const legacyAllocationCampaigns = allocationCampaigns.filter((campaign) => !rolloutCampaigns.some((rollout) => rollout.id === campaign.id));
    const nicheAllocationCampaigns = allocationCampaigns.filter((campaign) => rolloutCampaigns.some((rollout) => rollout.id === campaign.id));
    let operationalPlan: ReturnType<typeof resolveOperationalEnvelope> | null = null;
    let rolloutInventory: Awaited<ReturnType<typeof getMultiNicheCampaignInventory>> = [];
    if (rolloutCampaigns.length > 0) {
      try {
        const [capacity, inventory] = await Promise.all([
          getProductionCapacityDiagnostics(workspaceId, now),
          getMultiNicheCampaignInventory(MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS, getDayBounds(settings.timezone, now).start, getDayBounds(settings.timezone, now).end, now),
        ]);
        rolloutInventory = inventory;
        const verificationEnv = getVerificationEnv();
        const verificationSpend = await getTodaySpendUsd(workspaceId, "email_verification", settings.timezone, now);
        const verificationAvailable = verificationEnv.EMAIL_VERIFICATION_PROVIDER === "millionverifier"
          && Boolean(verificationEnv.MILLIONVERIFIER_API_KEY)
          && verificationEnv.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD > verificationSpend;
        const inventoryByCampaign = new Map(inventory.map((item) => [item.campaignId, item]));
        const routedCampaignById = new Map(nicheAllocationCampaigns.map((campaign) => [campaign.id, campaign]));
        operationalPlan = resolveOperationalEnvelope({
          businessDailyTarget: settings.globalDailyTarget,
          safeCapacityTarget: verificationAvailable ? capacity.operationalTarget.operationalDailyTarget : 0,
          backlogInventory: inventory.reduce((total, item) => total + item.backlogInventory, 0),
          rawRequestedToday: inventory.reduce((total, item) => total + item.rawRequestedToday, 0),
          campaigns: rolloutCampaigns.flatMap((campaign) => {
            const entry = getMultiNicheRolloutEntry(campaign.id);
            const stats = inventoryByCampaign.get(campaign.id);
            if (!entry || !stats) return [];
            const routed = routedCampaignById.get(campaign.id);
            const capability = capabilities.find((item) => item.engineType === routed?.engineType);
            return [{
              campaign,
              confirmedImports: stats.confirmedImports,
              rawRequestedToday: stats.rawRequestedToday,
              completedProbeCount: stats.completedProbeCount,
              providerAvailable: Boolean(capability?.available) && verificationAvailable,
            }];
          }),
        });
        logEvent("info", "autopilot.multi_niche_operational_envelope", {
          correlationId: `autopilot:${workspaceId}`,
          workspaceId,
          businessTarget: operationalPlan.businessTarget,
          operationalTarget: operationalPlan.operationalTarget,
          effectiveSchedulerTarget: operationalPlan.effectiveSchedulerTarget,
          remainingOperationalDemand: operationalPlan.remainingOperationalDemand,
          coldStartNiches: operationalPlan.coldStartNiches,
          coldStartProbeBudget: operationalPlan.coldStartProbeBudget,
          backlogContribution: operationalPlan.backlogContribution,
          bindingConstraint: verificationAvailable ? operationalPlan.bindingConstraint : "verification_provider",
          verificationAvailable,
          globalCampaignIds: MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS,
        });
      } catch (error) {
        logEvent("error", "autopilot.multi_niche_capacity_unavailable", {
          correlationId: `autopilot:${workspaceId}`,
          workspaceId,
          errorClass: error instanceof Error ? error.constructor.name : "NonError",
          effectiveSchedulerTarget: 0,
        });
      }
    }
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
      campaigns: legacyConcreteCampaigns,
      rawNeeded: planningRawLimit,
      eligible: apifyRecovery.recoveryProbeEligible,
      dailyBudgetAllowed: pacing.apifyDailyBudgetRemaining > 0,
      cooldownAt: apifyRecovery.nextRecoveryAttemptAt,
      credentialFingerprint: createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN) ?? "unconfigured",
      failureEpoch: apifyRecovery.latestFailureAt
        ? new Date(apifyRecovery.latestFailureAt).toISOString()
        : apifyRecovery.nextRecoveryAttemptAt?.toISOString() ?? "unknown",
      recoveryGeneration: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_URL ?? "local",
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
      workspaceId, campaigns: legacyAllocationCampaigns, capabilities, performances,
      economicPressureByEngine: {
        maps_fast: apifyEconomicPacing.state === "AHEAD_OF_BUDGET_PACE",
        maps_deep: apifyEconomicPacing.state === "AHEAD_OF_BUDGET_PACE",
        google_serp: serperEconomicPacing.state === "AHEAD_OF_BUDGET_PACE",
        linkedin_owner: serperEconomicPacing.state === "AHEAD_OF_BUDGET_PACE",
      },
      rawNeeded: planningRawLimit - recoveryProbeRaw, reason: pacing.explanation, now, timeZone: settings.timezone, origin: "normal",
    });
    const inventoryByCampaign = new Map(rolloutInventory.map((item) => [item.campaignId, item]));
    const coldStartOrders = operationalPlan?.coldStartAllocations.flatMap((allocation) => {
      const campaign = nicheAllocationCampaigns.find((item) => item.id === allocation.campaignId);
      if (!campaign) return [];
      const planningWindow = planningWindowKey(now, settings.timezone);
      return [{
        workspaceId,
        campaignId: campaign.id,
        engineType: campaign.engineType,
        desiredRawCount: allocation.rawCount,
        reason: `Bounded cold-start probe for ${allocation.niche}.`,
        planningWindow,
        idempotencyKey: `multi-niche-cold-start:${workspaceId}:${campaign.id}:${planningWindow}`,
        origin: "normal" as const,
      }];
    }) ?? [];
    const matureNicheCampaigns = nicheAllocationCampaigns.filter((campaign) =>
      (inventoryByCampaign.get(campaign.id)?.confirmedImports ?? 0) >= 5,
    );
    const economicNicheOrders = allocateEngineWork({
      workspaceId,
      campaigns: matureNicheCampaigns,
      capabilities,
      performances,
      rawNeeded: operationalPlan?.economicDemand ?? 0,
      reason: "Multi-niche economic exploitation within the operational envelope.",
      now,
      timeZone: settings.timezone,
      origin: "normal",
    });
    orders = [...orders, ...coldStartOrders, ...economicNicheOrders];
    for (const performance of performances) {
      const order = orders.find((item) => item.campaignId === performance.campaignId && item.engineType === performance.engineType);
      logEvent("info", "autopilot.cost_efficiency", {
        correlationId: `${workspaceId}:${performance.campaignId}:${planningWindowKey(now, settings.timezone)}`,
        workspaceId,
        campaignId: performance.campaignId,
        engineType: order?.engineType ?? performance.engineType ?? concreteCampaigns.find((campaign) => campaign.id === performance.campaignId)?.engineType ?? null,
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
      enabled: legacyCampaigns.some((campaign) => campaign.engineType === "hybrid_fill"),
      rawDeficit: Math.floor(pacing.rawNeededToPlan * discoveryBackpressureMultiplier),
      candidates: legacyConcreteCampaigns.map((campaign) => {
        const capability = capabilities.find((item) => item.engineType === campaign.engineType);
        const measured = performances.find((item) => item.campaignId === campaign.id && item.engineType === campaign.engineType);
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
          workspaceId, campaigns: legacyConcreteCampaigns, capabilities, performances, orders,
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

    const reservationOrders = orders.map((order) => ({
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
        economicPaceState: order.engineType === "maps_fast" || order.engineType === "maps_deep"
          ? apifyEconomicPacing.state
          : serperEconomicPacing.state,
      },
      idempotencyKey: order.idempotencyKey,
      desiredRawCount: order.desiredRawCount,
    }));
    const reservation = rolloutCampaigns.length > 0
      ? await enqueueDiscoveryOrdersWithinDailyRawCap(reservationOrders, now, {
        campaignIds: MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS,
        cap: operationalPlan?.effectiveSchedulerTarget ?? 0,
      })
      : await enqueueDiscoveryOrdersWithinDailyRawCap(reservationOrders, now);
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
