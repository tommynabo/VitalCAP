import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceAdmin: vi.fn(),
  getPilotControlState: vi.fn(),
  getAutopilotSettings: vi.fn(),
  getAutopilotPacingState: vi.fn(),
  getApifyRecoverySnapshot: vi.fn(),
  listAutopilotEnabledCampaigns: vi.fn(),
  enqueueDiscoveryOrdersWithinDailyRawCap: vi.fn(),
  acquirePilotRunPermit: vi.fn(),
  runDiscoveryCronTick: vi.fn(),
  runProviderRunsCronTick: vi.fn(),
  createApifyCredentialFingerprint: vi.fn(),
  getMapsEnv: vi.fn(),
  planApifyRecoveryProbe: vi.fn(),
}));

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceAdmin: mocks.requireWorkspaceAdmin,
}));
vi.mock("@/infrastructure/neon/repositories/pilot-control", () => ({
  getPilotControlState: mocks.getPilotControlState,
  acquirePilotRunPermit: mocks.acquirePilotRunPermit,
}));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ listAutopilotEnabledCampaigns: mocks.listAutopilotEnabledCampaigns }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: mocks.getAutopilotSettings,
  getAutopilotPacingState: mocks.getAutopilotPacingState,
}));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getApifyRecoverySnapshot: mocks.getApifyRecoverySnapshot }));
vi.mock("@/infrastructure/neon/repositories/daily-raw-request-cap", () => ({ enqueueDiscoveryOrdersWithinDailyRawCap: mocks.enqueueDiscoveryOrdersWithinDailyRawCap }));
vi.mock("@/infrastructure/jobs/runners/discovery-runner", () => ({ runDiscoveryCronTick: mocks.runDiscoveryCronTick }));
vi.mock("@/infrastructure/jobs/runners/provider-runs-runner", () => ({ runProviderRunsCronTick: mocks.runProviderRunsCronTick }));
vi.mock("@/services/discovery/provider-health", () => ({ createApifyCredentialFingerprint: mocks.createApifyCredentialFingerprint }));
vi.mock("@/services/autopilot/target-planner", () => ({
  MAX_APIFY_RECOVERY_PROBE_RAW: 10,
  planApifyRecoveryProbe: mocks.planApifyRecoveryProbe,
}));
vi.mock("@/lib/config/env", () => ({ getMapsEnv: mocks.getMapsEnv }));

const { POST } = await import("./route");

function request(body: unknown) {
  return new Request("http://localhost/api/admin/pilot-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const recoveryOrder = {
  campaignId: "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
  engineType: "maps_fast",
  desiredRawCount: 1,
  planningWindow: "2026-11-13T17:00",
  reason: "Apify recovery probe after provider cooldown.",
  idempotencyKey: "recovery-key",
};

describe("POST /api/admin/pilot-control recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceAdmin.mockResolvedValue({ workspaceId: "9cbd4033-86ae-4682-9a2e-c60751fc6aaa", user: { userId: "admin-1" } });
    mocks.getPilotControlState.mockResolvedValue({ status: "active", sessionId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c", workspaceId: "9cbd4033-86ae-4682-9a2e-c60751fc6aaa" });
    mocks.getAutopilotSettings.mockResolvedValue({ timezone: "Europe/Madrid", emergencyStopped: false });
    mocks.getAutopilotPacingState.mockResolvedValue({ rawRequestsRemaining: 10, apifyDailyBudgetRemaining: 1 });
    mocks.getApifyRecoverySnapshot.mockResolvedValue({ recoveryProbeEligible: true, safetyBlocked: false, nextRecoveryAttemptAt: new Date("2026-11-13T16:00:00.000Z"), latestFailureAt: null });
    mocks.listAutopilotEnabledCampaigns.mockResolvedValue([{
      id: recoveryOrder.campaignId,
      engineType: "maps_fast",
      status: "active",
      autopilotEnabled: true,
      dailySoftTarget: 1,
    }]);
    mocks.enqueueDiscoveryOrdersWithinDailyRawCap.mockImplementation(async (orders: Array<{ id: string; desiredRawCount: number }>) => ({
      orders: [{ id: orders[0]!.id, desiredRawCount: orders[0]!.desiredRawCount }],
    }));
    mocks.acquirePilotRunPermit.mockResolvedValue(true);
    mocks.runDiscoveryCronTick.mockResolvedValue({ providerRunsStarted: 1, jobsClaimed: 1 });
    mocks.runProviderRunsCronTick.mockResolvedValue({ runsChecked: 1 });
    mocks.createApifyCredentialFingerprint.mockReturnValue("credential-fingerprint");
    mocks.getMapsEnv.mockReturnValue({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "configured" });
    mocks.planApifyRecoveryProbe.mockReturnValue([recoveryOrder]);
  });

  it("requires the literal confirmation and reserves exactly one no-retry Apify job", async () => {
    const invalid = await POST(request({ action: "recovery", campaignId: recoveryOrder.campaignId, confirmation: "yes" }));
    expect(invalid.status).toBe(400);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();

    const response = await POST(request({ action: "recovery", campaignId: recoveryOrder.campaignId, confirmation: "RUN_ONE_APIFY_RECOVERY_PROBE" }));
    expect(response.status).toBe(200);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).toHaveBeenCalledWith([expect.objectContaining({
      campaignId: recoveryOrder.campaignId,
      desiredRawCount: 1,
      maxAttempts: 1,
      payload: expect.objectContaining({ engineType: "maps_fast", origin: "recovery_probe", pilotRunKey: "recovery" }),
    })], expect.any(Date));
    expect(mocks.acquirePilotRunPermit).toHaveBeenCalledWith(expect.objectContaining({
      runKey: "recovery",
      runType: "recovery",
      discoveryJobId: expect.any(String),
      actorUserId: "admin-1",
    }));
    expect(mocks.runDiscoveryCronTick).toHaveBeenCalledWith(1, expect.any(Date), expect.objectContaining({
      campaignId: recoveryOrder.campaignId,
      jobId: expect.any(String),
      pilotRunKey: "recovery",
    }));
    expect(mocks.runProviderRunsCronTick).toHaveBeenCalledWith(1, expect.objectContaining({ pilotRunKey: "recovery" }));
  });

  it("fails closed when the existing recovery planner returns no eligible order", async () => {
    mocks.planApifyRecoveryProbe.mockReturnValue([]);

    const response = await POST(request({ action: "recovery", campaignId: recoveryOrder.campaignId, confirmation: "RUN_ONE_APIFY_RECOVERY_PROBE" }));

    expect(response.status).toBe(409);
    expect(mocks.enqueueDiscoveryOrdersWithinDailyRawCap).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });
});
