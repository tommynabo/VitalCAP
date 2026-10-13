import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetHealthWorkspaceId, mockGetRecentProviderUsage, mockGetActiveAutopilotDiscoveryEngineTypes, mockGetSystemHealthDiagnostics } = vi.hoisted(() => ({
  mockGetHealthWorkspaceId: vi.fn(),
  mockGetRecentProviderUsage: vi.fn(),
  mockGetActiveAutopilotDiscoveryEngineTypes: vi.fn(),
  mockGetSystemHealthDiagnostics: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getRecentProviderUsage: mockGetRecentProviderUsage }));
vi.mock("@/infrastructure/neon/repositories/diagnostics", () => ({ getHealthWorkspaceId: mockGetHealthWorkspaceId, getActiveAutopilotDiscoveryEngineTypes: mockGetActiveAutopilotDiscoveryEngineTypes }));
vi.mock("@/infrastructure/neon/repositories/health-diagnostics", () => ({ getSystemHealthDiagnostics: mockGetSystemHealthDiagnostics }));

import { GET } from "./route";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import { resetAuthEnvCacheForTests } from "@/lib/config/auth-env";

const environmentNames = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "DATABASE_URL", "MAPS_PROVIDER", "SERP_PROVIDER", "SERPER_API_KEY", "SERPER_COUNTRY", "SERPER_LANGUAGE", "SERPER_DAILY_COST_LIMIT_USD", "DEFAULT_DELIVERY_MODE", "EMAIL_DELIVERY_PROVIDER", "INSTANTLY_API_KEY", "INSTANTLY_CAMPAIGN_ID", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "APIFY_API_TOKEN"];

describe("GET /api/health", () => {
  afterEach(() => {
    for (const name of environmentNames) delete process.env[name];
    mockGetHealthWorkspaceId.mockReset();
    mockGetRecentProviderUsage.mockReset();
    mockGetActiveAutopilotDiscoveryEngineTypes.mockReset();
    mockGetSystemHealthDiagnostics.mockReset();
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();
  });

  it("exposes safe runtime state without secrets", async () => {
    process.env.APP_ENV = "development";
    process.env.DEV_SEED_MODE = "true";
    process.env.MAPS_PROVIDER = "mock";
    process.env.DEFAULT_DELIVERY_MODE = "dry_run";
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      status: "ok",
      appEnv: "development",
      devSeedMode: true,
      databaseConfigured: false,
      auth: { configured: false },
      maps: { provider: "mock", configured: true },
      serp: { provider: "disabled", configured: false, health: "missing_configuration", status: "missing_configuration" },
      intelligence: { provider: "disabled", configured: true },
      verification: { provider: "disabled" },
      delivery: { mode: "dry_run", provider: "disabled", instantlyConfigured: false }
    });
    expect(body).not.toHaveProperty("DATABASE_URL");
    expect(body).not.toHaveProperty("APIFY_API_TOKEN");
    expect(body).not.toHaveProperty("NEON_AUTH_COOKIE_SECRET");
  });

  it("degrades when an active Autopilot engine requires an unconfigured SERP provider", async () => {
    process.env.APP_ENV = "development";
    process.env.DATABASE_URL = "postgresql://health-test";
    process.env.SERP_PROVIDER = "disabled";
    mockGetHealthWorkspaceId.mockResolvedValue("workspace-1");
    mockGetActiveAutopilotDiscoveryEngineTypes.mockResolvedValue(["google_serp"]);
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("degraded");
    expect(body.serp).toMatchObject({ provider: "disabled", configured: false, health: "missing_configuration" });
  });

  it("reports configured SERP health without exposing its key", async () => {
    process.env.APP_ENV = "development";
    process.env.SERP_PROVIDER = "serper";
    process.env.SERPER_API_KEY = "test-secret";
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(body.serp).toMatchObject({ provider: "serper", configured: true, health: "untested", status: "untested" });
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  it("reports Instantly configuration without exposing its key", async () => {
    process.env.APP_ENV = "development";
    process.env.EMAIL_DELIVERY_PROVIDER = "instantly";
    process.env.INSTANTLY_API_KEY = "instantly-secret";
    process.env.DEFAULT_DELIVERY_MODE = "dry_run";
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(body.delivery).toMatchObject({
      mode: "dry_run",
      provider: "instantly",
      instantlyConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain("instantly-secret");
  });

  it("exposes Maps and Serper health separately with safe failure categories", async () => {
    process.env.APP_ENV = "development";
    process.env.DATABASE_URL = "postgresql://health-secret";
    process.env.MAPS_PROVIDER = "apify";
    process.env.APIFY_API_TOKEN = "apify-secret";
    process.env.SERP_PROVIDER = "serper";
    process.env.SERPER_API_KEY = "serper-secret";
    process.env.INSTANTLY_CAMPAIGN_ID = "055534c5-c3e3-414f-b140-f4770b293c00";
    mockGetHealthWorkspaceId.mockResolvedValue("workspace-1");
    mockGetActiveAutopilotDiscoveryEngineTypes.mockResolvedValue(["maps_fast", "google_serp"]);
    mockGetRecentProviderUsage.mockImplementation(async (_workspaceId: string, provider: string) => ({
      calls: 3,
      items: provider === "serper" ? 9 : 1,
      errors: provider === "serper" ? 0 : 2,
      totalLatencyMs: 0,
      costUsd: 0,
      quotaRemaining: null,
    }));
    mockGetSystemHealthDiagnostics.mockResolvedValue({
      providers: {
        apify: {
          recentTerminalCalls: 3,
          recentErrors: 2,
          lastSuccessAt: "2026-10-10T10:00:00.000Z",
          lastFailureAt: "2026-10-11T10:00:00.000Z",
          lastFailureClass: "billing",
          budgetAllowed: false,
        },
        serper: {
          recentTerminalCalls: 3,
          recentErrors: 0,
          lastSuccessAt: "2026-10-11T10:00:00.000Z",
          lastFailureAt: null,
          lastFailureClass: null,
          budgetAllowed: true,
        },
      },
      autopilotEffectiveState: "running",
      systemPaused: false,
      systemPauseReason: null,
      queue: {
        duePendingDiscovery: 2,
        deferredDiscovery: 5,
        processingPending: 1,
        staleLocks: 0,
        manualProviderReconciliations: 0,
      },
    });
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(mockGetHealthWorkspaceId).toHaveBeenCalledWith("055534c5-c3e3-414f-b140-f4770b293c00");
    expect(mockGetActiveAutopilotDiscoveryEngineTypes).toHaveBeenCalledWith("workspace-1");
    expect(mockGetSystemHealthDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" }));
    expect(mockGetRecentProviderUsage).toHaveBeenCalledWith("workspace-1", "apify");
    expect(mockGetRecentProviderUsage).toHaveBeenCalledWith("workspace-1", "serper");

    expect(body.maps).toMatchObject({
      provider: "apify",
      configured: true,
      health: "paused",
      recentTerminalCalls: 3,
      recentErrors: 2,
      lastFailureClass: "billing",
      budgetAllowed: false,
      providerAvailable: false,
    });
    expect(body.serp).toMatchObject({
      provider: "serper",
      configured: true,
      health: "healthy",
      recentTerminalCalls: 3,
      recentErrors: 0,
      budgetAllowed: true,
      providerAvailable: true,
    });
    expect(body).toMatchObject({
      autopilotEffectiveState: "running",
      systemPaused: false,
      queue: { duePendingDiscovery: 2, deferredDiscovery: 5, staleLocks: 0 },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("apify-secret");
    expect(serialized).not.toContain("serper-secret");
    expect(serialized).not.toContain("health-secret");
    expect(serialized).not.toContain("raw provider payload");
  });

  it("reports mock Maps as configured but not implicitly healthy", async () => {
    process.env.MAPS_PROVIDER = "mock";
    resetServerEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(body.maps).toMatchObject({ configured: true, health: "untested", providerAvailable: true });
  });
});