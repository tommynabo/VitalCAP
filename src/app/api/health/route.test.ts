import { afterEach, describe, expect, it, vi } from "vitest";

const { mockListWorkspaceIds, mockGetRecentProviderUsage, mockGetActiveAutopilotDiscoveryEngineTypes } = vi.hoisted(() => ({
  mockListWorkspaceIds: vi.fn(),
  mockGetRecentProviderUsage: vi.fn(),
  mockGetActiveAutopilotDiscoveryEngineTypes: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ listWorkspaceIds: mockListWorkspaceIds }));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getRecentProviderUsage: mockGetRecentProviderUsage }));
vi.mock("@/infrastructure/neon/repositories/diagnostics", () => ({ getActiveAutopilotDiscoveryEngineTypes: mockGetActiveAutopilotDiscoveryEngineTypes }));

import { GET } from "./route";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import { resetAuthEnvCacheForTests } from "@/lib/config/auth-env";

const environmentNames = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "DATABASE_URL", "MAPS_PROVIDER", "SERP_PROVIDER", "SERPER_API_KEY", "SERPER_COUNTRY", "SERPER_LANGUAGE", "SERPER_DAILY_COST_LIMIT_USD", "DEFAULT_DELIVERY_MODE", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "APIFY_API_TOKEN"];

describe("GET /api/health", () => {
  afterEach(() => {
    for (const name of environmentNames) delete process.env[name];
    mockListWorkspaceIds.mockReset();
    mockGetRecentProviderUsage.mockReset();
    mockGetActiveAutopilotDiscoveryEngineTypes.mockReset();
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
      delivery: { mode: "dry_run", provider: "disabled" }
    });
    expect(body).not.toHaveProperty("DATABASE_URL");
    expect(body).not.toHaveProperty("APIFY_API_TOKEN");
    expect(body).not.toHaveProperty("NEON_AUTH_COOKIE_SECRET");
  });

  it("degrades when an active Autopilot engine requires an unconfigured SERP provider", async () => {
    process.env.APP_ENV = "development";
    process.env.DATABASE_URL = "postgresql://health-test";
    process.env.SERP_PROVIDER = "disabled";
    mockListWorkspaceIds.mockResolvedValue(["workspace-1"]);
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
});