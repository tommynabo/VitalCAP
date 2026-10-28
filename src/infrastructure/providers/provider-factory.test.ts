import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecordProviderRun, mockReserveSerperProviderRun, mockUpdateProviderRun, mockGetProviderRunByRequestKey, mockSearch, mockGetTodaySpendUsd, mockGetGlobalSerperSpendToday, mockGetSerperRecoveryState, mockGetSerperSpendByPurpose, mockGetSerperApiKey } = vi.hoisted(() => ({
  mockRecordProviderRun: vi.fn(),
  mockReserveSerperProviderRun: vi.fn(),
  mockUpdateProviderRun: vi.fn(),
  mockGetProviderRunByRequestKey: vi.fn(),
  mockSearch: vi.fn(),
  mockGetTodaySpendUsd: vi.fn(),
  mockGetGlobalSerperSpendToday: vi.fn(),
  mockGetSerperRecoveryState: vi.fn(),
  mockGetSerperSpendByPurpose: vi.fn(),
  mockGetSerperApiKey: vi.fn(() => "test-key"),
}));

vi.mock("@/lib/config/env", () => ({
  getSerperEnv: () => ({ SERP_PROVIDER: "serper", SERPER_API_KEY: mockGetSerperApiKey(), SERPER_DAILY_COST_LIMIT_USD: 0.5, SERPER_COUNTRY: "es", SERPER_LANGUAGE: "es" }),
}));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({
  getTodaySpendUsd: mockGetTodaySpendUsd,
  getGlobalSerperSpendToday: mockGetGlobalSerperSpendToday,
  getSerperRecoveryState: mockGetSerperRecoveryState,
  getSerperSpendByPurpose: mockGetSerperSpendByPurpose,
  getProviderRunByRequestKey: mockGetProviderRunByRequestKey,
  recordProviderRun: mockRecordProviderRun,
  reserveSerperProviderRun: mockReserveSerperProviderRun,
  updateProviderRun: mockUpdateProviderRun,
}));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: vi.fn().mockResolvedValue({ timezone: "Europe/Madrid" }),
}));
vi.mock("./serp/serper-provider", () => ({
  MAX_TRANSIENT_RETRIES: 1,
  SERPER_ESTIMATED_COST_PER_QUERY_USD: 0.001,
  SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD: 0.025,
  SerperDiscoveryProvider: class {
    search = mockSearch;
  },
}));

import { createSerpDiscoveryProvider } from "./provider-factory";

describe("Serper provider run recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSerperApiKey.mockReturnValue("test-key");
    mockSearch.mockReset();
    mockGetTodaySpendUsd.mockResolvedValue(0);
    mockGetGlobalSerperSpendToday.mockResolvedValue(0);
    mockGetSerperRecoveryState.mockResolvedValue({ allocationPaused: false, recoveryProbeEligible: false, nextRecoveryAttemptAt: null, lastFailureAt: null });
    mockGetSerperSpendByPurpose.mockResolvedValue(0);
    mockGetProviderRunByRequestKey.mockResolvedValue(null);
    mockReserveSerperProviderRun.mockResolvedValue({ providerRun: { id: "run-1", status: "starting", metadata: {} }, created: true });
  });

  it("records successful searches with campaign, engine, query, and item counts", async () => {
    mockSearch.mockResolvedValue({
      results: [{ title: "Farmacia", url: "https://example.es", domain: "example.es" }],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 12, costUsd: 0.001, quotaRemaining: null },
    });

    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");
    await provider.search({ query: "farmacia Barcelona", maxResults: 5 });

    expect(mockReserveSerperProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      itemsRequested: 5,
      metadata: expect.objectContaining({ engineType: "google_serp", purpose: "google_serp_discovery", queryFingerprint: expect.any(String) }),
    }));
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "completed", itemsReturned: 1, costUsd: 0.001 }));
    const completedMetadata = mockUpdateProviderRun.mock.calls[0]?.[1].metadata;
    expect(completedMetadata).toMatchObject({
      purpose: "google_serp_discovery",
      queryFingerprint: expect.any(String),
      country: "es",
      language: "es",
      maxResults: 5,
      httpAttempts: 1,
    });
    expect(completedMetadata).not.toHaveProperty("normalizedQuery");
    expect(completedMetadata).not.toHaveProperty("query");
  });

  it("records a successful zero-result response as completed, not failed", async () => {
    mockSearch.mockResolvedValue({
      results: [],
      usage: { calls: 1, items: 0, errors: 0, totalLatencyMs: 12, costUsd: 0.001, quotaRemaining: null },
    });

    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");
    await expect(provider.search({ query: "farmacia vacía", maxResults: 5, planningWindow: "2026-10-03T11:00" }))
      .resolves.toMatchObject({ results: [] });

    expect(mockReserveSerperProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ purpose: "google_serp_discovery", queryFingerprint: expect.any(String), planningWindow: expect.any(String) }),
    }));
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "completed", itemsReturned: 0 }));
  });

  it("does not make a second paid call for a completed request key", async () => {
    mockGetProviderRunByRequestKey.mockResolvedValue({ id: "run-existing", status: "completed", metadata: {} });

    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");
    await expect(provider.search({ query: "farmacia Barcelona", maxResults: 5, planningWindow: "2026-10-03T11:00" }))
      .resolves.toMatchObject({ results: [], usage: { calls: 0, costUsd: 0 } });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockReserveSerperProviderRun).not.toHaveBeenCalled();
  });

  it("defers a failed request instead of retrying it within the same planning window", async () => {
    mockGetProviderRunByRequestKey.mockResolvedValue({ id: "run-failed", status: "failed", error: "Serper rate limit", metadata: {} });

    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");
    await expect(provider.search({ query: "farmacia Barcelona", maxResults: 5, planningWindow: "2026-10-03T11:00" }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockReserveSerperProviderRun).not.toHaveBeenCalled();
  });

  it("records provider exceptions as failed runs and rethrows for job retry", async () => {
    mockSearch.mockRejectedValue(new Error("Serper rate limit"));

    const provider = createSerpDiscoveryProvider("workspace-1", "linkedin_owner", "campaign-2");
    await expect(provider.search({ query: "site:linkedin.com/in titular farmacia", maxResults: 10 }))
      .rejects.toThrow("Serper rate limit");

    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed", itemsReturned: 0, costUsd: 0, error: "Serper rate limit" }));
  });

  it("blocks calls after the Serper daily cost budget is exhausted", async () => {
    mockGetGlobalSerperSpendToday.mockResolvedValue(0.501);
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-3");

    await expect(provider.search({ query: "farmacia Barcelona", maxResults: 5 }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "budget_blocked",
      costUsd: 0,
      metadata: expect.objectContaining({ engineType: "google_serp", purpose: "google_serp_discovery", budgetBlocked: true }),
    }));
  });

  it("keeps existing account spend charged when a rotated key needs recovery", async () => {
    mockGetSerperApiKey.mockReturnValue("rotated-test-key");
    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: true,
      recoveryProbeEligible: true,
      nextRecoveryAttemptAt: new Date(Date.now() - 1),
      lastFailureAt: new Date(Date.now() - 60 * 60 * 1000),
      recoveredAt: null,
    });
    mockGetGlobalSerperSpendToday.mockResolvedValue(0.5);
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");

    await expect(provider.search({ query: "safe rotated-key probe", maxResults: 10 }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "budget_blocked",
      costUsd: 0,
      metadata: expect.objectContaining({ purpose: "recovery_probe", recoveryProbe: true }),
    }));
  });

  it.each([
    ["linkedin_owner", "linkedin_owner_discovery", 0.024],
    ["maps_deep", "maps_deep_enrichment", 0.049],
  ] as const)("blocks %s when its daily purpose allowance cannot cover the reserved attempts", async (engineType, purpose, currentSpend) => {
    mockGetSerperSpendByPurpose.mockResolvedValue(currentSpend);
    const provider = createSerpDiscoveryProvider("workspace-1", engineType, "campaign-1");

    await expect(provider.search({ query: "safe purpose limit probe", maxResults: 5 }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockGetSerperSpendByPurpose).toHaveBeenCalledWith(purpose, expect.any(Date), expect.any(String));
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "budget_blocked",
      costUsd: 0,
      metadata: expect.objectContaining({ purpose, purposeBudgetBlocked: true }),
    }));
  });

  it("does not contact Serper again during the billing recovery cooldown", async () => {
    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: true,
      recoveryProbeEligible: false,
      nextRecoveryAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
      lastFailureAt: new Date(),
      recoveredAt: null,
    });
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");

    await expect(provider.search({ query: "safe probe", maxResults: 5 })).rejects.toMatchObject({ name: "ProviderBudgetExceededError" });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockReserveSerperProviderRun).not.toHaveBeenCalled();
  });

  it("runs one one-result recovery probe on the same configured key and resumes allocation on success", async () => {
    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: true,
      recoveryProbeEligible: true,
      nextRecoveryAttemptAt: new Date(Date.now() - 1),
      lastFailureAt: new Date(Date.now() - 60 * 60 * 1000),
      recoveredAt: null,
    });
    mockSearch.mockResolvedValue({
      results: [{ title: "Probe", url: "https://example.es", domain: "example.es" }],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 1, costUsd: 0.001, quotaRemaining: null },
    });
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");

    const probe = await provider.search({ query: "existing safe seed", maxResults: 10 });

    expect(mockReserveSerperProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      itemsRequested: 1,
      costUsd: 0.001,
      metadata: expect.objectContaining({ purpose: "recovery_probe", recoveryProbe: true }),
    }));
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 1, maxRetries: 0 }));
    expect(probe.results).toEqual([]);
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "completed",
      costUsd: 0.001,
      metadata: expect.objectContaining({ purpose: "recovery_probe", httpAttempts: 1 }),
    }));

    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: false,
      recoveryProbeEligible: false,
      nextRecoveryAttemptAt: null,
      lastFailureAt: null,
      recoveredAt: new Date(),
    });
    mockSearch.mockResolvedValue({
      results: [],
      usage: { calls: 1, items: 0, errors: 0, totalLatencyMs: 1, costUsd: 0.001, quotaRemaining: null },
    });
    await provider.search({ query: "next normal query", maxResults: 5 });
    expect(mockReserveSerperProviderRun).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ purpose: "google_serp_discovery", recoveryProbe: false }),
    }));
  });

  it("uses one idempotent recovery reservation per credential and preserves the daily cap", async () => {
    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: true,
      recoveryProbeEligible: true,
      nextRecoveryAttemptAt: new Date(Date.now() - 1),
      lastFailureAt: new Date(Date.now() - 60 * 60 * 1000),
      recoveredAt: null,
    });
    mockGetProviderRunByRequestKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-a", status: "completed", metadata: { purpose: "recovery_probe" } })
      .mockResolvedValueOnce(null);
    mockSearch.mockResolvedValue({ results: [], usage: { calls: 1, items: 0, errors: 0, totalLatencyMs: 1, costUsd: 0.001, quotaRemaining: null } });

    await createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1").search({ query: "safe probe", maxResults: 10 });
    await createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1").search({ query: "safe probe", maxResults: 10 });
    mockGetSerperApiKey.mockReturnValue("rotated-test-key");
    await createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1").search({ query: "safe probe", maxResults: 10 });

    const firstRequestKey = mockReserveSerperProviderRun.mock.calls[0]?.[0].requestKey;
    const rotatedRequestKey = mockReserveSerperProviderRun.mock.calls[1]?.[0].requestKey;
    expect(mockGetProviderRunByRequestKey.mock.calls[0]?.[0]).toBe(mockGetProviderRunByRequestKey.mock.calls[1]?.[0]);
    expect(rotatedRequestKey).not.toBe(firstRequestKey);
    expect(mockReserveSerperProviderRun).toHaveBeenCalledTimes(2);
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockReserveSerperProviderRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      costUsd: 0.001,
      dailyCostLimitUsd: 0.5,
      itemsRequested: 1,
      metadata: expect.objectContaining({ purpose: "recovery_probe", recoveryProbe: true }),
    }));
    expect(mockSearch).toHaveBeenNthCalledWith(2, expect.objectContaining({ maxResults: 1, maxRetries: 0 }));
  });

  it("creates a new recovery request epoch after a cap-blocked probe reaches the next cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:01:00.000Z"));
    try {
      mockGetSerperRecoveryState.mockResolvedValue({
        allocationPaused: true,
        recoveryProbeEligible: true,
        nextRecoveryAttemptAt: new Date("2026-10-19T12:01:00.000Z"),
        lastFailureAt: new Date("2026-10-19T11:01:00.000Z"),
        recoveredAt: null,
      });
      mockReserveSerperProviderRun
        .mockResolvedValueOnce({ providerRun: { id: "run-blocked", status: "budget_blocked", error: "daily cap", metadata: { retryAt: "2026-10-20T00:00:00.000Z" } }, created: false })
        .mockResolvedValueOnce({ providerRun: { id: "run-next", status: "starting", metadata: {} }, created: true });
      mockSearch.mockResolvedValue({
        results: [],
        usage: { calls: 1, items: 0, errors: 0, totalLatencyMs: 1, costUsd: 0.001, quotaRemaining: null },
      });
      const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");

      await expect(provider.search({ query: "existing safe seed", maxResults: 10 })).rejects.toMatchObject({ name: "ProviderBudgetExceededError" });
      vi.setSystemTime(new Date("2026-10-19T13:01:00.000Z"));
      await provider.search({ query: "existing safe seed", maxResults: 10 });

      const firstRequestKey = mockReserveSerperProviderRun.mock.calls[0]?.[0].requestKey;
      const nextRequestKey = mockReserveSerperProviderRun.mock.calls[1]?.[0].requestKey;
      expect(nextRequestKey).not.toBe(firstRequestKey);
      expect(mockSearch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed recovery probe as zero-cost billing and leaves cooldown state to durable history", async () => {
    mockGetSerperRecoveryState.mockResolvedValue({
      allocationPaused: true,
      recoveryProbeEligible: true,
      nextRecoveryAttemptAt: new Date(Date.now() - 1),
      lastFailureAt: new Date(Date.now() - 60 * 60 * 1000),
      recoveredAt: null,
    });
    mockSearch.mockRejectedValue(Object.assign(new Error("Serper billing failure"), {
      kind: "billing",
      httpAttempts: 1,
      estimatedCostUsd: 0,
    }));
    mockGetProviderRunByRequestKey.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "run-1",
      status: "failed",
      error: "Serper billing failure",
      metadata: { purpose: "recovery_probe" },
    });
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");

    await expect(provider.search({ query: "existing safe seed", maxResults: 10 })).rejects.toThrow("Serper billing failure");
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 1, maxRetries: 0 }));
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "failed",
      costUsd: 0,
      metadata: expect.objectContaining({ purpose: "recovery_probe", recoveryProbe: true, failureKind: "billing", httpAttempts: 1, credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(JSON.stringify(mockUpdateProviderRun.mock.calls[0]?.[1].metadata)).not.toContain("test-key");
    await expect(provider.search({ query: "existing safe seed", maxResults: 10 })).rejects.toMatchObject({ name: "ProviderBudgetExceededError" });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockReserveSerperProviderRun).toHaveBeenCalledTimes(1);
  });
});