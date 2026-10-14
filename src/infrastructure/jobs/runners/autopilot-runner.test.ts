import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaceIds: vi.fn(),
  listAutopilotEnabledCampaigns: vi.fn(),
  getAutopilotSettings: vi.fn(),
  getAutopilotPacingState: vi.fn(),
  insertRebalanceDecision: vi.fn(),
  enqueueDiscoveryJob: vi.fn(),
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
  decideHybridFill: vi.fn(),
  buildMapsSeedCatalog: vi.fn(),
  buildSerpSeedCatalog: vi.fn(),
  getDeliveryEnv: vi.fn(),
  getMapsEnv: vi.fn(),
  getSerperEnv: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ listWorkspaceIds: mocks.listWorkspaceIds }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listAutopilotEnabledCampaigns: mocks.listAutopilotEnabledCampaigns }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: mocks.getAutopilotSettings,
  getAutopilotPacingState: mocks.getAutopilotPacingState,
  insertRebalanceDecision: mocks.insertRebalanceDecision,
}));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  enqueueDiscoveryJob: mocks.enqueueDiscoveryJob,
  getCampaignQueueDepth: mocks.getCampaignQueueDepth,
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
    mocks.enqueueDiscoveryJob.mockResolvedValue("job-1");

    const result = await runAutopilotCronTick(now);

    expect(pacing.status).toBe("behind_pace");
    expect(pacing.targetNeededToPlan).toBeGreaterThan(0);
    expect(pacing.rawNeededToPlan).toBeGreaterThan(0);
    expect(result.ordersScheduled).toBeGreaterThan(0);
    expect(mocks.enqueueDiscoveryJob).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-1",
      type: "run_engine_batch",
      payload: expect.objectContaining({ engineType: "maps_fast" }),
    }));
  });
});
