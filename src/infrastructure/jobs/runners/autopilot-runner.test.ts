import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaceIds: vi.fn(),
  listAutopilotEnabledCampaigns: vi.fn(),
  getAutopilotSettings: vi.fn(),
  getAutopilotPacingState: vi.fn(),
  getProductionCapacityDiagnostics: vi.fn(),
  getMultiNicheCampaignInventory: vi.fn(),
  insertRebalanceDecision: vi.fn(),
  enqueueDiscoveryOrdersWithinDailyRawCap: vi.fn(),
  getCampaignQueueDepth: vi.fn(),
  getWatchdogWorkspaceSignals: vi.fn(),
  bootstrapSearchSeeds: vi.fn(),
  listSearchSeedsForCampaignEngine: vi.fn(),
  getRecentProviderUsage: vi.fn(),
  getTodaySpendUsd: vi.fn(),
  getGlobalSerperSpendToday: vi.fn(),
  getLatestProviderEconomicPacingStates: vi.fn(),
  recordProviderRun: vi.fn(),
  getSerperRecoveryState: vi.fn(),
  getApifyRecoverySnapshot: vi.fn(),
  getAutopilotEnginePerformance: vi.fn(),
  buildEngineCapabilities: vi.fn(),
  evaluateProviderHealth: vi.fn(),
  getApifyAllocationHealth: vi.fn(),
  createApifyCredentialFingerprint: vi.fn(() => "credential-fingerprint"),
  decideHybridFill: vi.fn(),
  buildMapsSeedCatalog: vi.fn(),
  buildSerpSeedCatalog: vi.fn(),
  buildCampaignSeedCatalog: vi.fn(() => []),
  getDeliveryEnv: vi.fn(),
  getMapsEnv: vi.fn(),
  getSerperEnv: vi.fn(),
  getVerificationEnv: vi.fn(),
  refreshWatchdogPauseForWorkspace: vi.fn(),
  getPilotControlState: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ listWorkspaceIds: mocks.listWorkspaceIds }));
vi.mock("./watchdog-runner", () => ({ refreshWatchdogPauseForWorkspace: mocks.refreshWatchdogPauseForWorkspace }));
vi.mock("@/infrastructure/neon/repositories/pilot-control", () => ({ getPilotControlState: mocks.getPilotControlState }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listAutopilotEnabledCampaigns: mocks.listAutopilotEnabledCampaigns }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: mocks.getAutopilotSettings,
  getAutopilotPacingState: mocks.getAutopilotPacingState,
  insertRebalanceDecision: mocks.insertRebalanceDecision,
}));
vi.mock("@/infrastructure/neon/repositories/production-capacity-diagnostics", () => ({ getProductionCapacityDiagnostics: mocks.getProductionCapacityDiagnostics }));
vi.mock("@/infrastructure/neon/repositories/multi-niche-rollout", () => ({ getMultiNicheCampaignInventory: mocks.getMultiNicheCampaignInventory }));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  getCampaignQueueDepth: mocks.getCampaignQueueDepth,
}));
vi.mock("@/infrastructure/neon/repositories/watchdog-signals", () => ({
  getWatchdogWorkspaceSignals: mocks.getWatchdogWorkspaceSignals,
}));
vi.mock("@/infrastructure/neon/repositories/daily-raw-request-cap", () => ({
  enqueueDiscoveryOrdersWithinDailyRawCap: mocks.enqueueDiscoveryOrdersWithinDailyRawCap,
}));
vi.mock("@/infrastructure/neon/repositories/discovery", () => ({
  bootstrapSearchSeeds: mocks.bootstrapSearchSeeds,
  listSearchSeedsForCampaignEngine: mocks.listSearchSeedsForCampaignEngine,
}));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({
  getApifyRecoverySnapshot: mocks.getApifyRecoverySnapshot,
  getRecentProviderUsage: mocks.getRecentProviderUsage,
  getTodaySpendUsd: mocks.getTodaySpendUsd,
  getGlobalSerperSpendToday: mocks.getGlobalSerperSpendToday,
  getLatestProviderEconomicPacingStates: mocks.getLatestProviderEconomicPacingStates,
  recordProviderRun: mocks.recordProviderRun,
  getSerperRecoveryState: mocks.getSerperRecoveryState,
}));
vi.mock("@/infrastructure/neon/repositories/autopilot-engine-performance", () => ({
  autopilotEnginePerformanceKey: (campaignId: string, engineType: string) => `${campaignId}:${engineType}`,
  getAutopilotEnginePerformance: mocks.getAutopilotEnginePerformance,
}));
vi.mock("@/services/autopilot/engine-capability", () => ({ buildEngineCapabilities: mocks.buildEngineCapabilities }));
vi.mock("@/services/discovery/provider-health", () => ({
  evaluateProviderHealth: mocks.evaluateProviderHealth,
  getApifyAllocationHealth: mocks.getApifyAllocationHealth,
  createApifyCredentialFingerprint: mocks.createApifyCredentialFingerprint,
}));
vi.mock("@/services/discovery/hybrid-fill-decision", () => ({ decideHybridFill: mocks.decideHybridFill }));
vi.mock("@/services/discovery/spain-search-catalog", () => ({
  buildMapsSeedCatalog: mocks.buildMapsSeedCatalog,
  buildSerpSeedCatalog: mocks.buildSerpSeedCatalog,
  buildCampaignSeedCatalog: mocks.buildCampaignSeedCatalog,
  ICP_CATEGORY_TERMS: [],
  LINKEDIN_OWNER_ROLE_QUERIES: [],
}));
vi.mock("@/lib/config/env", () => ({
  getDeliveryEnv: mocks.getDeliveryEnv,
  getMapsEnv: mocks.getMapsEnv,
  getSerperEnv: mocks.getSerperEnv,
  getVerificationEnv: mocks.getVerificationEnv,
}));
vi.mock("@/infrastructure/providers/serp/serper-provider", () => ({ SERPER_ESTIMATED_COST_PER_QUERY_USD: 0.01 }));

import { runAutopilotCronTick } from "./autopilot-runner";
import { computeAutopilotPacing } from "@/services/autopilot/pacing-service";
import { MAX_RAW_PER_PLANNING_WINDOW } from "@/services/autopilot/target-planner";

describe("runAutopilotCronTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPilotControlState.mockResolvedValue({ status: "disabled", sessionId: null, workspaceId: null, enabledAt: null, endedAt: null });
    mocks.listWorkspaceIds.mockResolvedValue(["workspace-1"]);
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue([{
      id: "campaign-1",
      engineType: "maps_fast",
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
    }]);
    mocks.getAutopilotSettings.mockResolvedValue({
      enabled: true,
      emergencyStopped: false,
      systemPaused: false,
      timezone: "Europe/Madrid",
      globalDailyTarget: 250,
    });
    mocks.getProductionCapacityDiagnostics.mockResolvedValue({ operationalTarget: { operationalDailyTarget: 4 } });
    mocks.getMultiNicheCampaignInventory.mockResolvedValue([]);
    mocks.getVerificationEnv.mockReturnValue({
      EMAIL_VERIFICATION_PROVIDER: "millionverifier",
      MILLIONVERIFIER_API_KEY: "configured",
      EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD: 1,
    });
    mocks.getCampaignQueueDepth.mockResolvedValue(0);
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      workspaceId: "workspace-1",
      oldDueDiscovery: 0,
      deferredDiscovery: 0,
      oldProcessing: 0,
      staleDiscoveryLocks: 0,
      staleProcessingLocks: 0,
      manualReconciliations: 0,
      processingPending: 0,
      processingCompletedRecent: 0,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 0,
      systemPaused: false,
      systemPauseReason: null,
      systemPausedAt: null,
      oldestDueDiscoveryAgeMinutes: null,
      oldestProcessingAgeMinutes: null,
      recoveryProbeDiscoveryCount: 0,
    }]);
    mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mockImplementation(async (orders) => ({
      snapshot: { cap: 1523, committedRawRequests: 0, providerReservedRawRequests: 0, queuedRawRequests: 0, remainingRawRequests: 1523, overshootRawRequests: 0, blockedReason: null },
      orders: orders.map((order: { idempotencyKey: string; desiredRawCount: number }, index: number) => ({
        id: `job-${index}`,
        idempotencyKey: order.idempotencyKey,
        desiredRawCount: order.desiredRawCount,
      })),
    }));
    mocks.bootstrapSearchSeeds.mockResolvedValue(undefined);
    mocks.listSearchSeedsForCampaignEngine.mockResolvedValue([]);
    mocks.getRecentProviderUsage.mockResolvedValue([]);
    mocks.getTodaySpendUsd.mockResolvedValue(0);
    mocks.getGlobalSerperSpendToday.mockResolvedValue(0);
    mocks.getLatestProviderEconomicPacingStates.mockResolvedValue({});
    mocks.getSerperRecoveryState.mockResolvedValue({ allocationPaused: false, recoveryProbeEligible: false, nextRecoveryAttemptAt: null, lastFailureAt: null, recoveredAt: null });
    mocks.getApifyRecoverySnapshot.mockResolvedValue({ recoveryProbeEligible: false, nextRecoveryAttemptAt: null });
    mocks.getAutopilotEnginePerformance.mockResolvedValue(new Map());
    mocks.buildEngineCapabilities.mockReturnValue([{
      engineType: "maps_fast",
      available: true,
      providerConfigured: true,
      providerHealthy: true,
      providerUntested: false,
      costAllowed: true,
      campaignCount: 1,
      reasonUnavailable: null,
      reason: null,
    }]);
    mocks.evaluateProviderHealth.mockReturnValue("healthy");
    mocks.getApifyAllocationHealth.mockReturnValue("healthy");
    mocks.decideHybridFill.mockReturnValue([]);
    mocks.buildMapsSeedCatalog.mockReturnValue([]);
    mocks.getDeliveryEnv.mockReturnValue({ INSTANTLY_CAMPAIGN_ID: "instantly-campaign" });
    mocks.getMapsEnv.mockReturnValue({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "configured", APIFY_DAILY_COST_LIMIT_USD: 5 });
    mocks.getSerperEnv.mockReturnValue({
      SERP_PROVIDER: "serper",
      SERPER_API_KEY: "configured",
      SERPER_DAILY_COST_LIMIT_USD: 10,
    });
  });

  it("suppresses direct scheduling while an isolated pilot is active", async () => {
    mocks.getPilotControlState.mockResolvedValue({ status: "active", sessionId: "pilot-1", workspaceId: "workspace-1", enabledAt: null, endedAt: null });

    await expect(runAutopilotCronTick()).resolves.toMatchObject({
      campaignsTicked: 0,
      ordersScheduled: 0,
      pacingStates: [],
    });
    expect(mocks.listWorkspaceIds).not.toHaveBeenCalled();
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();
  });

  it("does not add discovery work while old due recovery jobs are waiting to drain", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      workspaceId: "workspace-1",
      oldDueDiscovery: 4,
      recoverableOldDueDiscovery: 4,
      deferredDiscovery: 0,
      oldProcessing: 0,
      staleDiscoveryLocks: 0,
      staleProcessingLocks: 0,
      manualReconciliations: 0,
      processingPending: 0,
      processingCompletedRecent: 0,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 0,
      emergencyStopped: false,
      systemPaused: false,
      systemPauseReason: null,
      systemPausedAt: null,
      oldestDueDiscoveryAgeMinutes: 45,
      oldestProcessingAgeMinutes: null,
      recoveryProbeDiscoveryCount: 0,
    }]);

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();
    expect(mocks.getAutopilotPacingState).not.toHaveBeenCalled();
  });

  it("routes the existing Maps Fast niche deficit through healthy Serper when Apify is unavailable", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const campaigns = ["yoga", "wellness", "premium", "personal"].map((niche) => ({
      id: `campaign-${niche}`,
      engineType: "maps_fast",
      engineConfig: { niche },
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
    }));
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue(campaigns);
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "paused", availableDiscoveryCapacity: true,
      estimatedYield: 0.5, yieldSampleSize: 30, now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.buildEngineCapabilities.mockReturnValue([
      { engineType: "maps_fast", available: false, providerConfigured: true, providerHealthy: false, providerUntested: false, costAllowed: true, campaignCount: 4, reasonUnavailable: "provider_paused", reason: "provider_paused" },
      { engineType: "google_serp", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 4, reasonUnavailable: null, reason: null },
    ]);

    const result = await runAutopilotCronTick(now);
    const scheduledOrders = mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[0] ?? [];

    expect(result.ordersScheduled).toBeGreaterThan(0);
    expect(scheduledOrders).toHaveLength(4);
    expect(scheduledOrders.map((order: { campaignId: string; payload: { engineType: string } }) => [order.campaignId, order.payload.engineType]))
      .toEqual(campaigns.map((campaign) => [campaign.id, "google_serp"]));
    expect(scheduledOrders.reduce((sum: number, order: { payload: { desiredRawCount: number } }) => sum + order.payload.desiredRawCount, 0))
      .toBeLessThanOrEqual(MAX_RAW_PER_PLANNING_WINDOW);
    expect(mocks.getGlobalSerperSpendToday).toHaveBeenCalledOnce();
  });

  it("keeps four rollout niches inside one safe daily envelope and reserves under the scoped cap", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const rollout = [
      ["65b9f85d-4c8b-4e52-99fb-217eb3acac1c", "yoga_pilates"],
      ["5e109452-2df2-4b1b-9afc-7baa1b67fc42", "spas_wellness"],
      ["47fce807-aac6-4a8a-90f9-6ad3bbbf4ca7", "premium_fitness"],
      ["53f56788-99d9-4d6a-8c71-ab2ffe075d85", "personal_training"],
    ] as const;
    const campaigns = rollout.map(([id, niche]) => ({
      id,
      engineType: "maps_fast",
      engineConfig: { niche },
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
      createdAt: "2025-01-01T00:00:00.000Z",
    }));
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue(campaigns);
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 5, providerHealth: "healthy", availableDiscoveryCapacity: true,
      estimatedYield: 0.1, yieldSampleSize: 0, now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.getMultiNicheCampaignInventory.mockResolvedValue(rollout.map(([campaignId]) => ({
      campaignId, rawRequestedToday: 0, backlogInventory: 0, confirmedImports: 0, completedProbeCount: 0,
    })));

    const result = await runAutopilotCronTick(now);
    const orders = mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[0] ?? [];
    const scopedCap = mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[2];

    expect(result.ordersScheduled).toBe(4);
    expect(orders).toHaveLength(4);
    expect(orders.reduce((sum: number, order: { desiredRawCount: number }) => sum + order.desiredRawCount, 0)).toBe(4);
    expect(scopedCap).toEqual({ campaignIds: rollout.map(([id]) => id), cap: 4 });
  });

  it("stops rollout discovery when the safe capacity target is exhausted", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const campaign = {
      id: "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
      engineType: "maps_fast",
      engineConfig: { niche: "yoga_pilates" },
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
    };
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue([campaign]);
    mocks.getProductionCapacityDiagnostics.mockResolvedValue({ operationalTarget: { operationalDailyTarget: 0 } });
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", dailyTarget: 250, targetAchievedToday: 0,
      rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0, providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0, apifySpendToday: 0, apifyDailyBudgetRemaining: 5,
      providerHealth: "healthy", availableDiscoveryCapacity: true, estimatedYield: 0.1, yieldSampleSize: 0,
      now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.getMultiNicheCampaignInventory.mockResolvedValue([{
      campaignId: campaign.id, rawRequestedToday: 0, backlogInventory: 0, confirmedImports: 0, completedProbeCount: 0,
    }]);

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[2]).toMatchObject({ cap: 0 });
  });

  it("throttles new-niche discovery when verification budget/provider capacity is exhausted", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const campaign = {
      id: "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
      engineType: "maps_fast",
      engineConfig: { niche: "yoga_pilates" },
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
    };
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue([campaign]);
    mocks.getTodaySpendUsd.mockResolvedValue(1);
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", dailyTarget: 250, targetAchievedToday: 0,
      rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0, providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0, apifySpendToday: 0, apifyDailyBudgetRemaining: 5,
      providerHealth: "healthy", availableDiscoveryCapacity: true, estimatedYield: 0.1, yieldSampleSize: 0,
      now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.getMultiNicheCampaignInventory.mockResolvedValue([{
      campaignId: campaign.id, rawRequestedToday: 0, backlogInventory: 0, confirmedImports: 0, completedProbeCount: 0,
    }]);

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(0);
    expect(mocks.getTodaySpendUsd).toHaveBeenCalledWith("workspace-1", "email_verification", "Europe/Madrid", now);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[2]).toMatchObject({ cap: 0 });
  });

  it("schedules no paid rollout discovery when both discovery providers are unavailable", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const campaign = {
      id: "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
      engineType: "maps_fast",
      engineConfig: { niche: "yoga_pilates" },
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 250,
    };
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue([campaign]);
    mocks.buildEngineCapabilities.mockReturnValue([
      { engineType: "maps_fast", available: false, providerConfigured: true, providerHealthy: false, providerUntested: false, costAllowed: false, campaignCount: 1, reasonUnavailable: "provider_paused", reason: "provider_paused" },
      { engineType: "google_serp", available: false, providerConfigured: true, providerHealthy: false, providerUntested: false, costAllowed: false, campaignCount: 1, reasonUnavailable: "provider_paused", reason: "provider_paused" },
    ]);
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", dailyTarget: 250, targetAchievedToday: 0,
      rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0, providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0, apifySpendToday: 0, apifyDailyBudgetRemaining: 5,
      providerHealth: "healthy", availableDiscoveryCapacity: true, estimatedYield: 0.1, yieldSampleSize: 0,
      now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.getMultiNicheCampaignInventory.mockResolvedValue([{
      campaignId: campaign.id, rawRequestedToday: 0, backlogInventory: 2, confirmedImports: 0, completedProbeCount: 0,
    }]);

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[0]).toEqual([]);
  });

  it("avoids new discovery for a zero-import target covered by eligible paid backlog", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const pacing = computeAutopilotPacing({
      workspaceId: "workspace-1",
      timeZone: "Europe/Madrid",
      targetMetric: "instantly_imported",
      dailyTarget: 250,
      targetAchievedToday: 0,
      instantlyImportedToday: 0,
      eligibleImportBacklog: 10_000,
      expectedImportsFromBacklog: 10_000,
      rawRequestedToday: 0,
      rawReturnedToday: 0,
      processingInFlight: 0,
      providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0,
      apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9,
      providerHealth: "healthy",
      availableDiscoveryCapacity: true,
      estimatedYield: 0.5,
      yieldSampleSize: 30,
      now,
      operatingStartHour: 7,
      operatingEndHour: 22,
    });
    mocks.getAutopilotPacingState.mockResolvedValue(pacing);
    const result = await runAutopilotCronTick(now);

    expect(pacing.status).toBe("on_pace");
    expect(pacing.targetNeededToPlan).toBe(0);
    expect(pacing.rawNeededToPlan).toBe(0);
    expect(result.ordersScheduled).toBe(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).toHaveBeenCalledWith([], now);
    expect(mocks.recordProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      provider: "apify",
      operation: "economic_pacing_state",
      costUsd: 0,
      metadata: expect.objectContaining({ economicPaceState: "UNDER_PACE" }),
    }));
  });

  it("stops new discovery at the confirmed-import target while logging the stop", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 250, instantlyImportedToday: 250,
      confirmedImportsToday: 250,
      rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 4, providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0, apifySpendToday: 1, apifyDailyBudgetRemaining: 4,
      providerHealth: "healthy", availableDiscoveryCapacity: true, estimatedYield: 0.2,
      yieldSampleSize: 30, now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runAutopilotCronTick(now);

      expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { message: string; fields: Record<string, unknown> });
      expect(events.find((event) => event.message === "autopilot.target_reached_stop")?.fields).toMatchObject({
        confirmedImportsToday: 250,
        remainingTarget: 0,
        processingPending: 4,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("logs workspace-level contactability and recovery aggregates without prospect identifiers", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, qualifiedContactabilityBacklog: 12,
      contactabilityHistoricalSample: 20, contactabilityImportYield: 0.2,
      expectedImportsFromContactabilityBacklog: 2, eligibleImportBacklog: 3,
      expectedImportsFromBacklog: 3, rawRequestedToday: 0, rawReturnedToday: 0,
      processingInFlight: 4, providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0,
      apifySpendToday: 0, apifyDailyBudgetRemaining: 5, providerHealth: "healthy",
      availableDiscoveryCapacity: true, estimatedYield: 0.2, yieldSampleSize: 30, now,
      operatingStartHour: 7, operatingEndHour: 22,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runAutopilotCronTick(now);
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { message: string; fields: Record<string, unknown> });
      const funnel = events.find((event) => event.message === "contactability.funnel_snapshot");
      const recovery = events.find((event) => event.message === "maps_fast.website_recovery_outcomes");
      const economics = events.find((event) => event.message === "autopilot.economic_acceptance_snapshot");

      expect(funnel?.fields).toMatchObject({
        qualifiedAccounts: 0,
        contactabilityHistoricalSample: 20,
        contactabilityImportYield: 0.2,
        expectedImportsFromContactabilityBacklog: 2,
        processingPending: 4,
      });
      expect(recovery?.fields).toMatchObject({
        attempted: 0,
        succeeded: 0,
        terminalNoMatch: 0,
        transientFailure: 0,
        budgetBlocked: 0,
      });
      expect(economics?.fields).toMatchObject({
        confirmedImportsToday: 0,
        targetImports: 250,
        projectedEndOfDayImportsLow: 0,
        projectedEndOfDayImportsBase: 2,
        projectedEndOfDayImportsHigh: 5,
      });
      expect(JSON.stringify([funnel, recovery, economics])).not.toMatch(/@|\+?\d{8,}|https?:\/\//);
    } finally {
      log.mockRestore();
    }
  });

  it("does not schedule new work when the global cap has no remaining capacity", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "healthy", availableDiscoveryCapacity: true,
      estimatedYield: 0.5, yieldSampleSize: 30, now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mockResolvedValue({
      snapshot: { cap: 1523, committedRawRequests: 1523, providerReservedRawRequests: 1000, queuedRawRequests: 523, remainingRawRequests: 0, overshootRawRequests: 0, blockedReason: "daily_raw_request_cap_reached" },
      orders: [],
    });

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).toHaveBeenCalledTimes(1);
  });

  it("limits a scheduling decision to the remaining global capacity", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "healthy", availableDiscoveryCapacity: true,
      estimatedYield: 0.5, yieldSampleSize: 30, now, operatingStartHour: 7, operatingEndHour: 22,
    }));
    mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mockImplementation(async (orders) => ({
      snapshot: { cap: 1523, committedRawRequests: 1520, providerReservedRawRequests: 1400, queuedRawRequests: 120, remainingRawRequests: 3, overshootRawRequests: 0, blockedReason: null },
      orders: orders.slice(0, 1).map((order: { idempotencyKey: string }, index: number) => ({
        id: `job-${index}`, idempotencyKey: order.idempotencyKey, desiredRawCount: 3,
      })),
    }));

    const result = await runAutopilotCronTick(now);

    expect(result.ordersScheduled).toBe(3);
    expect(result.ordersScheduled).toBeLessThanOrEqual(3);
  });

  it("scales discovery work down for a large but draining processing queue", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const pacing = computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "healthy", availableDiscoveryCapacity: true,
      estimatedYield: 0.5, yieldSampleSize: 30, now, operatingStartHour: 7, operatingEndHour: 22,
    });
    mocks.getAutopilotPacingState.mockResolvedValue(pacing);
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      workspaceId: "workspace-1", oldDueDiscovery: 0, deferredDiscovery: 0, oldProcessing: 170,
      staleDiscoveryLocks: 0, staleProcessingLocks: 0, manualReconciliations: 0,
      processingPending: 170, processingCompletedRecent: 40, processingFailedRecent: 0,
      processingTimedOutRecent: 0, processingEnqueuedRecent: 0, systemPaused: false,
      systemPauseReason: null, systemPausedAt: null, oldestDueDiscoveryAgeMinutes: null,
      oldestProcessingAgeMinutes: 45, recoveryProbeDiscoveryCount: 0,
    }]);

    const result = await runAutopilotCronTick(now);
    const scheduledOrders = mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[0] ?? [];
    const scheduledRaw = scheduledOrders.reduce((sum: number, order: { payload: { desiredRawCount: number } }) => sum + order.payload.desiredRawCount, 0);

    expect(result.ordersScheduled).toBeGreaterThan(0);
    expect(scheduledRaw).toBeLessThan(pacing.rawNeededToPlan);
  });

  it("does not generate discovery orders while processing health is stalled", async () => {
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      workspaceId: "workspace-1", oldDueDiscovery: 0, deferredDiscovery: 0, oldProcessing: 170,
      staleDiscoveryLocks: 0, staleProcessingLocks: 1, manualReconciliations: 0,
      processingPending: 170, processingCompletedRecent: 0, processingFailedRecent: 0,
      processingTimedOutRecent: 0, processingEnqueuedRecent: 0, systemPaused: false,
      systemPauseReason: null, systemPausedAt: null, oldestDueDiscoveryAgeMinutes: null,
      oldestProcessingAgeMinutes: 45, recoveryProbeDiscoveryCount: 0,
    }]);
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "healthy", availableDiscoveryCapacity: true,
      estimatedYield: 0.5, yieldSampleSize: 30, now: new Date("2025-06-15T12:00:00Z"),
      operatingStartHour: 7, operatingEndHour: 22,
    }));

    const result = await runAutopilotCronTick(new Date("2025-06-15T12:00:00Z"));
    const scheduledOrders = mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mock.calls[0]?.[0] ?? [];

    expect(result.ordersScheduled).toBe(0);
    expect(scheduledOrders).toEqual([]);
  });

  it("refreshes a watchdog-owned pause and schedules one bounded probe even when provider-paused pacing has zero normal demand", async () => {
    const now = new Date("2025-06-15T12:00:00Z");
    mocks.getAutopilotSettings
      .mockResolvedValueOnce({
        enabled: true,
        emergencyStopped: false,
        systemPaused: true,
        systemPauseReason: "Queue health deteriorated (watchdog)",
        timezone: "Europe/Madrid",
      })
      .mockResolvedValueOnce({
        enabled: true,
        emergencyStopped: false,
        systemPaused: false,
        systemPauseReason: null,
        timezone: "Europe/Madrid",
      });
    mocks.getAutopilotPacingState.mockResolvedValue(computeAutopilotPacing({
      workspaceId: "workspace-1", timeZone: "Europe/Madrid", targetMetric: "instantly_imported",
      dailyTarget: 250, targetAchievedToday: 0, instantlyImportedToday: 0, eligibleImportBacklog: 0,
      expectedImportsFromBacklog: 0, rawRequestedToday: 0, rawReturnedToday: 0, processingInFlight: 0,
      providerRunsInFlight: 0, expectedQualifiedFromInFlight: 0, apifySpendToday: 0,
      apifyDailyBudgetRemaining: 9, providerHealth: "paused", availableDiscoveryCapacity: false,
      estimatedYield: 0.1, yieldSampleSize: 0, now, operatingStartHour: 7, operatingEndHour: 22,
      maxDailyRawRequests: 1_000,
    }));
    mocks.getApifyRecoverySnapshot.mockResolvedValue({
      recoveryProbeEligible: true,
      recoveryProbeInFlight: false,
      nextRecoveryAttemptAt: now,
      credentialChangedSinceLatestFailure: true,
    });

    const result = await runAutopilotCronTick(now);

    expect(mocks.refreshWatchdogPauseForWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(result.ordersScheduled).toBe(10);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({
          origin: "recovery_probe",
          recoveryCredentialFingerprint: "credential-fingerprint",
          desiredRawCount: 10,
        }),
      }),
    ], now);
  });

  it.each([
    { emergencyStopped: false, systemPaused: true, systemPauseReason: "operator_hold" },
    { emergencyStopped: true, systemPaused: false, systemPauseReason: null },
  ])("does not refresh or schedule through an operator safety pause", async (settings) => {
    mocks.getAutopilotSettings.mockResolvedValue({ enabled: true, timezone: "Europe/Madrid", ...settings });

    await runAutopilotCronTick(new Date("2025-06-15T12:00:00Z"));

    expect(mocks.refreshWatchdogPauseForWorkspace).not.toHaveBeenCalled();
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();
  });
});
