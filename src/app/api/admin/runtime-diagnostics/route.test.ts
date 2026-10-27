import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getApifyRecoverySnapshot,
  getApifyDailyEconomicTotals,
  getCurrentWorkspaceId,
  getDb,
  getAutopilotPacingState,
  getSeedEconomicPerformance,
  getSystemHealthDiagnostics,
  getRecoveryProbeDiscoveryJobs,
  getWatchdogWorkspaceSignals,
  getWorkspaceRole,
  listSearchSeedsForCampaignEngine,
  listCampaigns,
  requireCurrentUser,
} = vi.hoisted(() => ({
  getApifyRecoverySnapshot: vi.fn(),
  getApifyDailyEconomicTotals: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  getDb: vi.fn(),
  getAutopilotPacingState: vi.fn(),
  getSeedEconomicPerformance: vi.fn(),
  getSystemHealthDiagnostics: vi.fn(),
  getRecoveryProbeDiscoveryJobs: vi.fn(),
  getWatchdogWorkspaceSignals: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listSearchSeedsForCampaignEngine: vi.fn(),
  listCampaigns: vi.fn(),
  requireCurrentUser: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => null) }));
vi.mock("@/infrastructure/neon/db", () => ({ getDb }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listCampaigns }));
vi.mock("@/infrastructure/neon/schema/autopilot", () => ({
  autopilotSettings: { enabled: {}, systemPaused: {}, systemPauseReason: {}, systemPausedAt: {}, emergencyStopped: {}, globalDailyTarget: {}, targetMetric: {}, timezone: {} },
}));
vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ getWorkspaceRole }));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getApifyRecoverySnapshot }));
vi.mock("@/infrastructure/neon/repositories/discovery", () => ({ getApifyDailyEconomicTotals, getSeedEconomicPerformance, listSearchSeedsForCampaignEngine }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({ getAutopilotPacingState }));
vi.mock("@/infrastructure/neon/repositories/health-diagnostics", () => ({ getSystemHealthDiagnostics }));
vi.mock("@/infrastructure/neon/repositories/watchdog-signals", () => ({ getRecoveryProbeDiscoveryJobs, getWatchdogWorkspaceSignals }));
vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  getCurrentWorkspaceId,
  requireCurrentUser,
}));
vi.mock("@/lib/config/env-utils", () => ({ resolveNeonVar: vi.fn(() => undefined) }));
vi.mock("@/services/autopilot/watchdog-pause-policy", () => ({ getWatchdogPausePredicates: vi.fn(() => []) }));
vi.mock("@/lib/config/env", () => ({
  getMapsEnv: () => ({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "test-token", APIFY_DAILY_COST_LIMIT_USD: 15 }),
  getSerperEnv: () => ({ SERP_PROVIDER: "serper", SERPER_API_KEY: "test-key", SERPER_DAILY_COST_LIMIT_USD: 0.5 }),
}));

const { GET } = await import("./route");

describe("GET /api/admin/runtime-diagnostics recovery errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWorkspaceId.mockResolvedValue("workspace-1");
    requireCurrentUser.mockResolvedValue({ userId: "admin-1" });
    getWorkspaceRole.mockResolvedValue("admin");
    listCampaigns.mockResolvedValue([]);
    getApifyDailyEconomicTotals.mockResolvedValue({ runs: 0, spendUsd: 0, resultsReturned: 0, accountedResultsReturned: 0, newRaw: 0, duplicates: 0 });
    getAutopilotPacingState.mockResolvedValue({ instantlyImportedToday: 0, qualifiedToday: 0, validEmailToday: 0 });
    getSeedEconomicPerformance.mockResolvedValue(new Map());
    listSearchSeedsForCampaignEngine.mockResolvedValue([]);
    getApifyRecoverySnapshot.mockResolvedValue({
      recoveryProbeEligible: true,
      recoveryProbeInFlight: false,
      nextRecoveryAttemptAt: null,
      safetyBlocked: false,
      latestFailureKind: null,
      latestFailureAt: null,
      latestFailureMessage: null,
      latestSuccessAt: null,
      credentialChangedSinceLatestFailure: true,
      usage: { calls: 0, errors: 0, items: 0, costUsd: 0, totalLatencyMs: 0, quotaRemaining: null },
    });
    getSystemHealthDiagnostics.mockResolvedValue({
      providers: {
        apify: { recentTerminalCalls: 10, recentErrors: 3, lastSuccessAt: null, lastFailureAt: null, lastFailureClass: null, budgetAllowed: true },
        serper: { recentTerminalCalls: 12, recentErrors: 0, lastSuccessAt: null, lastFailureAt: null, lastFailureClass: null, budgetAllowed: true },
      },
      autopilotEffectiveState: "running",
      systemPaused: false,
      systemPauseReason: null,
      queue: {
        duePendingDiscovery: 0, deferredDiscovery: 0, discoveryProcessing: 0,
        discoveryStaleLocks: 0, processingPending: 0, processingProcessing: 0,
        processingStaleLocks: 0, manualProviderReconciliations: 0,
      },
    });
    getWatchdogWorkspaceSignals.mockResolvedValue([]);
    getRecoveryProbeDiscoveryJobs.mockResolvedValue([{
      id: "job-1",
      campaignId: "campaign-1",
      engineType: "maps_fast",
      origin: "recovery_probe",
      desiredRawCount: 10,
      status: "pending",
      attemptCount: 2,
      maxAttempts: 5,
      createdAt: "2026-10-18T09:00:00.000Z",
      nextAttemptAt: null,
      lockedAt: null,
      lockExpiresAt: null,
      providerDeferred: false,
      lastErrorPresent: true,
      lastError: "ZodError: query farmacia Sevilla {\"APIFY_API_TOKEN\":\"apify_api_private\",\"mail\":\"person@example.com\"}",
      sensitiveTerms: ["farmacia", "Sevilla"],
    }]);
    getDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ enabled: true, systemPaused: false, emergencyStopped: false, target: 250, targetMetric: "instantly_imported", timezone: "Europe/Madrid" }] }),
        }),
      }),
    });
  });

  it("returns sanitized recovery error details without the raw stored last_error", async () => {
    const response = await GET();
    const body = await response.json();
    const recoveryJob = body.discoveryRecoveryJobs[0];
    const serialized = JSON.stringify(recoveryJob);

    expect(response.status).toBe(200);
    expect(recoveryJob).toMatchObject({
      lastErrorClass: "ZodError",
      lastErrorSafeMessage: expect.any(String),
      lastFailureKind: "configuration",
    });
    expect(serialized).not.toContain("lastError\":");
    expect(serialized).not.toContain("APIFY_API_TOKEN");
    expect(serialized).not.toContain("apify_api_private");
    expect(serialized).not.toContain("farmacia");
    expect(serialized).not.toContain("Sevilla");
    expect(serialized).not.toContain("person@example.com");
    expect(body.apify).toMatchObject({
      reliabilityHealth: "degraded",
      allocationHealth: "paused",
      providerAvailable: false,
      recentTerminalCalls: 10,
      recentErrors: 3,
      recentErrorRate: 0.3,
      budgetAllowed: true,
    });
    expect(body.apify.credentialChangedSinceLatestFailure).toBe(true);
    expect(body.autopilot).toMatchObject({ target: 250, targetMetric: "instantly_imported" });
    expect(body.discoveryEconomics).toMatchObject({
      apifySpendTodayUsd: 0,
      apifyResultsToday: 0,
      newRawToday: 0,
      qualifiedToday: 0,
      validEmailToday: 0,
      instantlyImportedToday: 0,
    });
    expect(body.serper).toMatchObject({
      reliabilityHealth: "healthy",
      allocationHealth: "healthy",
      providerAvailable: true,
      recentTerminalCalls: 12,
      recentErrors: 0,
      budgetAllowed: true,
    });
  });

  it("exposes recovered Apify allocation separately from recent reliability", async () => {
    getApifyRecoverySnapshot.mockResolvedValue({
      recoveryProbeEligible: false,
      recoveryProbeInFlight: false,
      nextRecoveryAttemptAt: null,
      safetyBlocked: false,
      latestFailureKind: "billing",
      latestFailureAt: "2026-10-19T12:00:00.000Z",
      latestFailureMessage: null,
      latestSuccessAt: "2026-10-19T13:30:00.000Z",
      usage: { calls: 4, errors: 0, items: 2, costUsd: 0.1, totalLatencyMs: 0, quotaRemaining: null },
    });
    getSystemHealthDiagnostics.mockImplementation(async () => ({
      providers: {
        apify: { recentTerminalCalls: 33, recentErrors: 10, lastSuccessAt: "2026-10-19T13:30:00.000Z", lastFailureAt: "2026-10-19T12:00:00.000Z", lastFailureClass: "billing", budgetAllowed: true },
        serper: { recentTerminalCalls: 20, recentErrors: 0, lastSuccessAt: null, lastFailureAt: null, lastFailureClass: null, budgetAllowed: true },
      },
      autopilotEffectiveState: "running",
      systemPaused: false,
      systemPauseReason: null,
      queue: {
        duePendingDiscovery: 0, deferredDiscovery: 0, discoveryProcessing: 0,
        discoveryStaleLocks: 0, processingPending: 0, processingProcessing: 0,
        processingStaleLocks: 0, manualProviderReconciliations: 0,
      },
    }));

    const body = await (await GET()).json();

    expect(body.apify).toMatchObject({
      reliabilityHealth: "degraded",
      allocationHealth: "healthy",
      providerAvailable: true,
      recentTerminalCalls: 33,
      recentErrors: 10,
      recentErrorRate: 10 / 33,
      budgetAllowed: true,
      recoveredAfterLatestFailure: true,
      lastFailureClass: "billing",
    });
  });

  it("keeps downstream outcomes unknown when seed attribution is incomplete", async () => {
    listCampaigns.mockResolvedValue([{
      id: "campaign-1",
      name: "Campaign",
      status: "active",
      autopilotEnabled: true,
      engineType: "maps_fast",
      dailySoftTarget: 25,
      timeZone: "Europe/Madrid",
    }]);
    listSearchSeedsForCampaignEngine.mockResolvedValue(["seed-1", "seed-2"].map((id) => ({
      id,
      campaignId: "campaign-1",
      engineType: "maps_fast",
      query: "query",
      geography: "Madrid",
      lastRunAt: null,
      totalRaw: 10,
      totalUnique: 10,
      totalReady: 0,
      yieldRate: 0,
      exhaustionScore: 0,
      nextEligibleAt: null,
    })));
    const performance = (seedId: string, outcomeAttributionComplete: boolean) => ({
        seedId,
        recentRuns: 1,
        itemsReturned: 10,
        newRaw: 10,
        duplicates: 0,
        noveltyRate: 1,
        providerCostUsd: 0.1,
        providerCostTodayUsd: 0.1,
        outcomeAttributionComplete,
        itemsReturnedToday: 10,
        newRawToday: 10,
        duplicatesToday: 0,
        costPerNewRaw: 0.01,
        qualifiedFromSeed: outcomeAttributionComplete ? 4 : null,
        websiteFromSeed: null,
        emailFoundFromSeed: null,
        validEmailFromSeed: null,
        confirmedInstantlyImportsFromSeed: null,
        qualifiedYield: outcomeAttributionComplete ? 0.4 : null,
        websiteRate: null,
        emailFoundRate: null,
        validEmailYield: null,
        validEmailRate: null,
        confirmedImportYield: null,
        instantlyImportRate: null,
        costPerConfirmedImport: null,
        sampleSize: 10,
        zeroNoveltyRunStreak: 0,
        lastRunAt: "2026-10-27T10:00:00.000Z",
        nextEligibleAt: null,
      });
    getSeedEconomicPerformance.mockResolvedValue(new Map([
      ["seed-1", performance("seed-1", false)],
      ["seed-2", performance("seed-2", true)],
    ]));

    const body = await (await GET()).json();

    expect(body.discoveryEconomics.byCampaign[0]).toMatchObject({
      outcomeAttributionCompleteSeeds: 1,
      outcomeAttributionUnknownSeeds: 1,
      qualified: null,
      qualifiedYield: null,
    });
    expect(body.discoveryEconomics.bySeed[0]).toMatchObject({
      outcomeAttributionComplete: false,
      qualifiedYield: null,
    });
  });
});