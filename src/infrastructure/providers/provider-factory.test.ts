import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecordProviderRun, mockSearch, mockGetTodaySpendUsd } = vi.hoisted(() => ({
  mockRecordProviderRun: vi.fn(),
  mockSearch: vi.fn(),
  mockGetTodaySpendUsd: vi.fn(),
}));

vi.mock("@/lib/config/env", () => ({
  getSerperEnv: () => ({ SERP_PROVIDER: "serper", SERPER_API_KEY: "test-key", SERPER_DAILY_COST_LIMIT_USD: 0.5, SERPER_COUNTRY: "es", SERPER_LANGUAGE: "es" }),
}));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({
  getTodaySpendUsd: mockGetTodaySpendUsd,
  recordProviderRun: mockRecordProviderRun,
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
  });

  it("records successful searches with campaign, engine, query, and item counts", async () => {
    mockSearch.mockResolvedValue({
      results: [{ title: "Farmacia", url: "https://example.es", domain: "example.es" }],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 12, costUsd: 0.001, quotaRemaining: null },
    });

    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-1");
    await provider.search({ query: "farmacia Barcelona", maxResults: 5 });

    expect(mockRecordProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      campaignId: "campaign-1",
      provider: "serper",
      status: "completed",
      itemsRequested: 5,
      itemsReturned: 1,
      metadata: { engineType: "google_serp", query: "farmacia Barcelona" },
    }));
  });

  it("records provider exceptions as failed runs and rethrows for job retry", async () => {
    mockSearch.mockRejectedValue(new Error("Serper rate limit"));

    const provider = createSerpDiscoveryProvider("workspace-1", "linkedin_owner", "campaign-2");
    await expect(provider.search({ query: "site:linkedin.com/in titular farmacia", maxResults: 10 }))
      .rejects.toThrow("Serper rate limit");

    expect(mockRecordProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      campaignId: "campaign-2",
      provider: "serper",
      status: "failed",
      itemsRequested: 10,
      itemsReturned: 0,
      costUsd: 0,
      error: "Serper rate limit",
      metadata: { engineType: "linkedin_owner", query: "site:linkedin.com/in titular farmacia" },
    }));
  });

  it("blocks calls after the Serper daily cost budget is exhausted", async () => {
    mockGetTodaySpendUsd.mockResolvedValue(0.5);
    const provider = createSerpDiscoveryProvider("workspace-1", "google_serp", "campaign-3");

    await expect(provider.search({ query: "farmacia Barcelona", maxResults: 5 }))
      .rejects.toMatchObject({ name: "ProviderBudgetExceededError" });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockRecordProviderRun).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-3",
      provider: "serper",
      status: "budget_blocked",
      costUsd: 0,
      metadata: expect.objectContaining({ engineType: "google_serp", query: "farmacia Barcelona", budgetBlocked: true }),
    }));
  });
});