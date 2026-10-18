import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getApifyRecoverySnapshot,
  getCurrentWorkspaceId,
  getDb,
  getRecoveryProbeDiscoveryJobs,
  getWatchdogWorkspaceSignals,
  getWorkspaceRole,
  listCampaigns,
  requireCurrentUser,
} = vi.hoisted(() => ({
  getApifyRecoverySnapshot: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  getDb: vi.fn(),
  getRecoveryProbeDiscoveryJobs: vi.fn(),
  getWatchdogWorkspaceSignals: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listCampaigns: vi.fn(),
  requireCurrentUser: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => null) }));
vi.mock("@/infrastructure/neon/db", () => ({ getDb }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listCampaigns }));
vi.mock("@/infrastructure/neon/schema/autopilot", () => ({
  autopilotSettings: { enabled: {}, systemPaused: {}, systemPauseReason: {}, systemPausedAt: {}, emergencyStopped: {}, globalDailyTarget: {} },
}));
vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ getWorkspaceRole }));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getApifyRecoverySnapshot }));
vi.mock("@/infrastructure/neon/repositories/watchdog-signals", () => ({ getRecoveryProbeDiscoveryJobs, getWatchdogWorkspaceSignals }));
vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  getCurrentWorkspaceId,
  requireCurrentUser,
}));
vi.mock("@/lib/config/env-utils", () => ({ resolveNeonVar: vi.fn(() => undefined) }));
vi.mock("@/services/discovery/provider-health", () => ({ getApifyAllocationHealth: vi.fn(() => "paused") }));
vi.mock("@/services/autopilot/watchdog-pause-policy", () => ({ getWatchdogPausePredicates: vi.fn(() => []) }));

const { GET } = await import("./route");

describe("GET /api/admin/runtime-diagnostics recovery errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWorkspaceId.mockResolvedValue("workspace-1");
    requireCurrentUser.mockResolvedValue({ userId: "admin-1" });
    getWorkspaceRole.mockResolvedValue("admin");
    listCampaigns.mockResolvedValue([]);
    getApifyRecoverySnapshot.mockResolvedValue({
      recoveryProbeEligible: true,
      recoveryProbeInFlight: false,
      nextRecoveryAttemptAt: null,
      latestFailureKind: null,
      latestFailureAt: null,
      latestFailureMessage: null,
      latestSuccessAt: null,
      usage: {},
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
          where: () => ({ limit: async () => [{ enabled: true, systemPaused: false, emergencyStopped: false, target: 250 }] }),
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
  });
});