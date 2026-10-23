import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaceIds: vi.fn(),
  listAutopilotEnabledCampaigns: vi.fn(),
  getAutopilotSettings: vi.fn(),
  getAutopilotPacingState: vi.fn(),
  insertRebalanceDecision: vi.fn(),
  enqueueDiscoveryOrdersWithinDailyRawCap: vi.fn(),
  getCampaignQueueDepth: vi.fn(),
  bootstrapSearchSeeds: vi.fn(),
  listSearchSeedsForCampaignEngine: vi.fn(),
  getRecentProviderUsage: vi.fn(),
  getTodaySpendUsd: vi.fn(),
  getApifyRecoverySnapshot: vi.fn(),
  getAutopilotEnginePerformance: vi.fn(),
  buildEngineCapabilities: vi.fn(),
  evaluateProviderHealth: vi.fn(),
  getApifyAllocationHealth: vi.fn(),
  createApifyCredentialFingerprint: vi.fn(() => "credential-fingerprint"),
  decideHybridFill: vi.fn(),
  buildMapsSeedCatalog: vi.fn(),
  buildSerpSeedCatalog: vi.fn(),
  getDeliveryEnv: vi.fn(),
  getMapsEnv: vi.fn(),
  getSerperEnv: vi.fn(),
  refreshWatchdogPauseForWorkspace: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ listWorkspaceIds: mocks.listWorkspaceIds }));
vi.mock("./watchdog-runner", () => ({ refreshWatchdogPauseForWorkspace: mocks.refreshWatchdogPauseForWorkspace }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listAutopilotEnabledCampaigns: mocks.listAutopilotEnabledCampaigns }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: mocks.getAutopilotSettings,
  getAutopilotPacingState: mocks.getAutopilotPacingState,
  insertRebalanceDecision: mocks.insertRebalanceDecision,
}));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  getCampaignQueueDepth: mocks.getCampaignQueueDepth,
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
}));
vi.mock("@/infrastructure/neon/repositories/autopilot-engine-performance", () => ({
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
  ICP_CATEGORY_TERMS: [],
  LINKEDIN_OWNER_ROLE_QUERIES: [],
}));
vi.mock("@/lib/config/env", () => ({
  getDeliveryEnv: mocks.getDeliveryEnv,
  getMapsEnv: mocks.getMapsEnv,
  getSerperEnv: mocks.getSerperEnv,
}));
vi.mock("@/infrastructure/providers/serp/serper-provider", () => ({ SERPER_ESTIMATED_COST_PER_QUERY_USD: 0.01 }));

import { runAutopilotCronTick } from "./autopilot-runner";
import { computeAutopilotPacing } from "@/services/autopilot/pacing-service";

describe("runAutopilotCronTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    });
    mocks.getCampaignQueueDepth.mockResolvedValue(0);
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
    mocks.getMapsEnv.mockReturnValue({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "configured" });
    mocks.getSerperEnv.mockReturnValue({
      SERP_PROVIDER: "serper",
      SERPER_API_KEY: "configured",
      SERPER_DAILY_COST_LIMIT_USD: 10,
    });
  });

  it("enqueues discovery for a zero-import 250 target despite a large stale backlog", async () => {
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

    expect(pacing.status).toBe("behind_pace");
    expect(pacing.targetNeededToPlan).toBeGreaterThan(0);
    expect(pacing.rawNeededToPlan).toBeGreaterThan(0);
    expect(result.ordersScheduled).toBeGreaterThan(0);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        campaignId: "campaign-1",
        type: "run_engine_batch",
        payload: expect.objectContaining({ engineType: "maps_fast" }),
      }),
    ]), now);
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
