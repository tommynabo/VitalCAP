import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecordProviderRun, mockReserveSerperProviderRun, mockUpdateProviderRun, mockGetProviderRunByRequestKey, mockSearch, mockGetTodaySpendUsd } = vi.hoisted(() => ({
  mockRecordProviderRun: vi.fn(),
  mockReserveSerperProviderRun: vi.fn(),
  mockUpdateProviderRun: vi.fn(),
  mockGetProviderRunByRequestKey: vi.fn(),
  mockSearch: vi.fn(),
  mockGetTodaySpendUsd: vi.fn(),
}));

vi.mock("@/lib/config/env", () => ({
  getSerperEnv: () => ({ SERP_PROVIDER: "serper", SERPER_API_KEY: "test-key", SERPER_DAILY_COST_LIMIT_USD: 0.5, SERPER_COUNTRY: "es", SERPER_LANGUAGE: "es" }),
}));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({
  getTodaySpendUsd: mockGetTodaySpendUsd,
  getProviderRunByRequestKey: mockGetProviderRunByRequestKey,
  recordProviderRun: mockRecordProviderRun,
  reserveSerperProviderRun: mockReserveSerperProviderRun,
  updateProviderRun: mockUpdateProviderRun,
}));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: vi.fn().mockResolvedValue({ timezone: "Europe/Madrid" }),
}));
vi.mock("./serp/serper-provider", () => ({
  SERPER_ESTIMATED_COST_PER_QUERY_USD: 0.001,
  SerperDiscoveryProvider: class {
    search = mockSearch;
  },
}));

import { createSerpDiscoveryProvider } from "./provider-factory";

describe("Serper provider run recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockReset();
    mockGetTodaySpendUsd.mockResolvedValue(0);
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
      metadata: expect.objectContaining({ engineType: "google_serp", normalizedQuery: "farmacia barcelona" }),
    }));
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "completed", itemsReturned: 1 }));
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
      metadata: expect.objectContaining({ normalizedQuery: "farmacia vacía", planningWindow: "2026-10-03T11:00" }),
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
    mockGetTodaySpendUsd.mockResolvedValue(0.501);
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-3");

    await expect(provider.search({ query: "farmacia Barcelona", maxResults: 5 }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUpdateProviderRun).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "budget_blocked",
      costUsd: 0,
      metadata: expect.objectContaining({ engineType: "google_serp", query: "farmacia Barcelona", budgetBlocked: true }),
    }));
  });
});