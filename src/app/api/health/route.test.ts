import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetHealthWorkspaceIds, mockGetApifyRecoverySnapshot, mockGetActiveAutopilotDiscoveryEngineTypes, mockGetSystemHealthDiagnostics } = vi.hoisted(() => ({
  mockGetHealthWorkspaceIds: vi.fn(),
  mockGetApifyRecoverySnapshot: vi.fn(),
  mockGetActiveAutopilotDiscoveryEngineTypes: vi.fn(),
  mockGetSystemHealthDiagnostics: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getApifyRecoverySnapshot: mockGetApifyRecoverySnapshot }));
vi.mock("@/infrastructure/neon/repositories/diagnostics", () => ({ getHealthWorkspaceIds: mockGetHealthWorkspaceIds, getActiveAutopilotDiscoveryEngineTypes: mockGetActiveAutopilotDiscoveryEngineTypes }));
vi.mock("@/infrastructure/neon/repositories/health-diagnostics", () => ({ getSystemHealthDiagnostics: mockGetSystemHealthDiagnostics }));

import { GET } from "./route";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import { resetAuthEnvCacheForTests } from "@/lib/config/auth-env";

const environmentNames = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "DATABASE_URL", "MAPS_PROVIDER", "SERP_PROVIDER", "SERPER_API_KEY", "SERPER_COUNTRY", "SERPER_LANGUAGE", "SERPER_DAILY_COST_LIMIT_USD", "DEFAULT_DELIVERY_MODE", "INSTANTLY_CAMPAIGN_ID", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "APIFY_API_TOKEN"];

const emptyUsage = { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null };
const healthyUsage = { ...emptyUsage, calls: 4, items: 8 };
type RecoveryFixture = {
  usage: typeof emptyUsage;
  recoveryProbeEligible: boolean;
  nextRecoveryAttemptAt: Date | null;
  safetyBlocked: boolean;
  latestFailureAt: Date | string | null;
  latestSuccessAt: Date | string | null;
};

const healthyRecovery: RecoveryFixture = {
  usage: healthyUsage,
  recoveryProbeEligible: false,
  nextRecoveryAttemptAt: null,
  safetyBlocked: false,
  latestFailureAt: null,
  latestSuccessAt: null,
};
const emptyQueue = {
  duePendingDiscovery: 0,
  deferredDiscovery: 0,
  discoveryProcessing: 0,
  discoveryStaleLocks: 0,
  processingPending: 0,
  processingProcessing: 0,
  processingStaleLocks: 0,
  manualProviderReconciliations: 0,
};

function diagnostics(overrides: Record<string, unknown> = {}) {
  const defaults = {
    providers: {
      apify: { recentTerminalCalls: 4, recentErrors: 0, lastSuccessAt: null, lastFailureAt: null, lastFailureClass: null, budgetAllowed: true },
      serper: { recentTerminalCalls: 4, recentErrors: 0, lastSuccessAt: null, lastFailureAt: null, lastFailureClass: null, budgetAllowed: true },
    },
    autopilotEffectiveState: "running",
    systemPaused: false,
    systemPauseReason: null,
    queue: emptyQueue,
  };
  return {
    ...defaults,
    ...overrides,
    providers: { ...defaults.providers, ...(overrides.providers as object ?? {}) },
    queue: { ...defaults.queue, ...(overrides.queue as object ?? {}) },
  };
}

function configureHealthEnvironment() {
  process.env.APP_ENV = "development";
  process.env.DATABASE_URL = "postgresql://health-test";
  process.env.MAPS_PROVIDER = "apify";
  process.env.APIFY_API_TOKEN = "apify-secret";
  process.env.SERP_PROVIDER = "serper";
  process.env.SERPER_API_KEY = "serper-secret";
  process.env.INSTANTLY_CAMPAIGN_ID = "055534c5-c3e3-414f-b140-f4770b293c00";
  resetServerEnvCacheForTests();
  resetAuthEnvCacheForTests();
}

function configureWorkspaces(fixtures: Record<string, {
  engineTypes: string[];
  diagnostics?: ReturnType<typeof diagnostics>;
  apifyUsage?: typeof emptyUsage;
  serperUsage?: typeof emptyUsage;
  apifyRecovery?: RecoveryFixture;
}>) {
  mockGetHealthWorkspaceIds.mockResolvedValue(Object.keys(fixtures));
  mockGetActiveAutopilotDiscoveryEngineTypes.mockImplementation(async (workspaceId: string) => fixtures[workspaceId]?.engineTypes ?? []);
  mockGetSystemHealthDiagnostics.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => {
    const current = fixtures[workspaceId];
    const base = current?.diagnostics ?? diagnostics();
    return {
      ...base,
      providers: {
        ...base.providers,
        apify: {
          ...base.providers.apify,
          recentTerminalCalls: current?.apifyUsage?.calls ?? base.providers.apify.recentTerminalCalls,
          recentErrors: current?.apifyUsage?.errors ?? base.providers.apify.recentErrors,
        },
        serper: {
          ...base.providers.serper,
          recentTerminalCalls: current?.serperUsage?.calls ?? base.providers.serper.recentTerminalCalls,
          recentErrors: current?.serperUsage?.errors ?? base.providers.serper.recentErrors,
        },
      },
    };
  });
  mockGetApifyRecoverySnapshot.mockImplementation(async (workspaceId: string) => fixtures[workspaceId]?.apifyRecovery ?? healthyRecovery);
}

describe("GET /api/health", () => {
  beforeEach(() => {
    mockGetHealthWorkspaceIds.mockReset();
    mockGetApifyRecoverySnapshot.mockReset();
    mockGetActiveAutopilotDiscoveryEngineTypes.mockReset();
    mockGetSystemHealthDiagnostics.mockReset();
    mockGetHealthWorkspaceIds.mockResolvedValue([]);
    mockGetApifyRecoverySnapshot.mockResolvedValue(healthyRecovery);
    mockGetActiveAutopilotDiscoveryEngineTypes.mockResolvedValue([]);
    mockGetSystemHealthDiagnostics.mockResolvedValue(diagnostics());
  });

  afterEach(() => {
    for (const name of environmentNames) delete process.env[name];
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
    mockGetHealthWorkspaceIds.mockResolvedValue(["workspace-1"]);
    mockGetActiveAutopilotDiscoveryEngineTypes.mockResolvedValue(["google_serp"]);
    mockGetSystemHealthDiagnostics.mockResolvedValue(diagnostics());
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

  it("exposes Maps and Serper health separately with safe failure categories", async () => {
    process.env.APP_ENV = "development";
    process.env.DATABASE_URL = "postgresql://health-secret";
    process.env.MAPS_PROVIDER = "apify";
    process.env.APIFY_API_TOKEN = "apify-secret";
    process.env.SERP_PROVIDER = "serper";
    process.env.SERPER_API_KEY = "serper-secret";
    process.env.INSTANTLY_CAMPAIGN_ID = "055534c5-c3e3-414f-b140-f4770b293c00";
    configureWorkspaces({
      "workspace-1": {
        engineTypes: ["maps_fast", "google_serp"],
        diagnostics: diagnostics({
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
          queue: { duePendingDiscovery: 2, deferredDiscovery: 5 },
        }),
        apifyUsage: { ...healthyUsage, calls: 3, errors: 2 },
        serperUsage: { ...healthyUsage, calls: 3 },
      },
    });
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const response = await GET();
    const body = await response.json();

    expect(mockGetHealthWorkspaceIds).toHaveBeenCalledWith("055534c5-c3e3-414f-b140-f4770b293c00");
    expect(mockGetActiveAutopilotDiscoveryEngineTypes).toHaveBeenCalledWith("workspace-1");
    expect(mockGetSystemHealthDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" }));
    expect(mockGetApifyRecoverySnapshot).toHaveBeenCalledWith("workspace-1");

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
      queue: { duePendingDiscovery: 2, deferredDiscovery: 5, discoveryStaleLocks: 0, processingStaleLocks: 0 },
      healthWorkspaceCount: 1,
      operationalWorkspaceCount: 1,
      healthScope: "single_workspace",
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

  it("ignores a historical target-linked workspace without an active Autopilot path", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      active: { engineTypes: ["maps_fast", "google_serp"] },
      historical: { engineTypes: [] },
    });

    const body = await (await GET()).json();

    expect(body).toMatchObject({ status: "ok", healthWorkspaceCount: 2, operationalWorkspaceCount: 1, healthScope: "single_workspace" });
    expect(body.maps.health).toBe("healthy");
    expect(body.serp.health).toBe("healthy");
    expect(mockGetSystemHealthDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("aggregates multiple operational workspaces without a uniqueness failure", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      "workspace-a": { engineTypes: ["maps_fast"] },
      "workspace-b": { engineTypes: ["google_serp"] },
    });

    const body = await (await GET()).json();

    expect(body).toMatchObject({ status: "ok", healthWorkspaceCount: 2, operationalWorkspaceCount: 2, healthScope: "multi_workspace" });
    expect(body.maps.health).toBe("healthy");
    expect(body.serp.health).toBe("healthy");
    expect(body.autopilotEffectiveState).toBe("running");
  });

  it("keeps a paused operational workspace visible and degrades aggregate health", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      running: { engineTypes: ["maps_fast"] },
      paused: {
        engineTypes: ["google_serp"],
        diagnostics: diagnostics({ autopilotEffectiveState: "system_paused", systemPaused: true, systemPauseReason: "queue_health" }),
      },
    });

    const body = await (await GET()).json();

    expect(body).toMatchObject({
      status: "degraded",
      autopilotEffectiveState: "system_paused",
      systemPaused: true,
      pausedOperationalWorkspaceCount: 1,
    });
  });

  it("does not let a paused required provider become healthy in the aggregate", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      "workspace-a": { engineTypes: ["maps_fast"] },
      "workspace-b": {
        engineTypes: ["maps_fast"],
        apifyUsage: { ...healthyUsage, calls: 4, errors: 3 },
        apifyRecovery: { ...healthyRecovery, recoveryProbeEligible: true },
      },
    });

    const body = await (await GET()).json();

    expect(body.status).toBe("degraded");
    expect(body.maps.health).toBe("paused");
    expect(body.maps.providerAvailable).toBe(false);
  });

  it("keeps production ready when recent Apify reliability is degraded but recovery allows allocation", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      active: {
        engineTypes: ["maps_fast"],
        apifyUsage: { ...healthyUsage, calls: 33, errors: 10 },
        apifyRecovery: {
          ...healthyRecovery,
          latestFailureAt: "2026-10-19T12:00:00.000Z",
          latestSuccessAt: "2026-10-19T13:30:00.000Z",
        },
      },
    });

    const body = await (await GET()).json();

    expect(body.status).toBe("ok");
    expect(body.maps).toMatchObject({
      health: "degraded",
      reliabilityHealth: "degraded",
      allocationHealth: "healthy",
      providerAvailable: true,
      recentTerminalCalls: 33,
      recentErrors: 10,
      recentErrorRate: 10 / 33,
      recoveredAfterLatestFailure: true,
    });
  });

  it("degrades production for an unresolved latest Apify billing failure", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      active: {
        engineTypes: ["maps_fast"],
        diagnostics: diagnostics({
          providers: { apify: { lastFailureClass: "billing", budgetAllowed: true } },
        }),
        apifyRecovery: {
          ...healthyRecovery,
          recoveryProbeEligible: false,
          nextRecoveryAttemptAt: new Date("2026-10-19T14:00:00.000Z"),
          latestFailureAt: "2026-10-19T13:00:00.000Z",
          latestSuccessAt: "2026-10-19T12:00:00.000Z",
        },
      },
    });

    const body = await (await GET()).json();

    expect(body.status).toBe("degraded");
    expect(body.maps).toMatchObject({ allocationHealth: "paused", providerAvailable: false, lastFailureClass: "billing" });
  });

  it("degrades production when the required Apify budget is exhausted", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      active: {
        engineTypes: ["maps_fast"],
        diagnostics: diagnostics({ providers: { apify: { budgetAllowed: false } } }),
      },
    });

    const body = await (await GET()).json();

    expect(body.status).toBe("degraded");
    expect(body.maps).toMatchObject({ allocationHealth: "paused", budgetAllowed: false, providerAvailable: false });
  });

  it("aggregates healthy Serper and Apify provider states across operational workspaces", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      "workspace-a": { engineTypes: ["maps_fast", "google_serp"] },
      "workspace-b": { engineTypes: ["maps_fast", "google_serp"] },
    });

    const body = await (await GET()).json();

    expect(body.status).toBe("ok");
    expect(body.maps.health).toBe("healthy");
    expect(body.serp.health).toBe("healthy");
  });

  it("returns safe unknown health when no target-linked workspace is operational", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      historicalA: { engineTypes: [] },
      historicalB: { engineTypes: [] },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "degraded", healthWorkspaceCount: 2, operationalWorkspaceCount: 0, autopilotEffectiveState: "unknown" });
    expect(body.maps.health).toBe("unknown");
    expect(body.serp.health).toBe("unknown");
    expect(JSON.stringify(body)).not.toContain("historicalA");
    expect(JSON.stringify(body)).not.toContain("historicalB");
  });

  it("sums queue counters across operational workspaces", async () => {
    configureHealthEnvironment();
    configureWorkspaces({
      "workspace-a": {
        engineTypes: ["maps_fast"],
        diagnostics: diagnostics({ queue: { duePendingDiscovery: 2, deferredDiscovery: 3, discoveryProcessing: 4, discoveryStaleLocks: 1, processingPending: 5, processingProcessing: 6, processingStaleLocks: 2, manualProviderReconciliations: 3 } }),
      },
      "workspace-b": {
        engineTypes: ["maps_fast"],
        diagnostics: diagnostics({ queue: { duePendingDiscovery: 7, deferredDiscovery: 8, discoveryProcessing: 9, discoveryStaleLocks: 4, processingPending: 10, processingProcessing: 11, processingStaleLocks: 5, manualProviderReconciliations: 6 } }),
      },
    });

    const body = await (await GET()).json();

    expect(body.queue).toEqual({
      duePendingDiscovery: 9,
      deferredDiscovery: 11,
      discoveryProcessing: 13,
      discoveryStaleLocks: 5,
      processingPending: 15,
      processingProcessing: 17,
      processingStaleLocks: 7,
      manualProviderReconciliations: 9,
    });
    expect(body.status).toBe("degraded");
  });
});