import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceOwner: vi.fn(),
  getApifyRecoverySnapshot: vi.fn(),
  getProductivityDiagnostics: vi.fn(),
  getProductionCapacityDiagnostics: vi.fn(),
  getSystemHealthDiagnostics: vi.fn(),
  getMapsEnv: vi.fn(),
  getSerperEnv: vi.fn(),
  getDeliveryEnv: vi.fn(),
  getDb: vi.fn(),
  buildProviderHealthSnapshot: vi.fn(),
  runAutopilotCronTick: vi.fn(),
  runDiscoveryCronTick: vi.fn(),
  runProviderRunsCronTick: vi.fn(),
  runProcessingCronTick: vi.fn(),
  refreshWatchdogPauseForWorkspace: vi.fn(),
  enqueueVerificationJobs: vi.fn(),
  runVerificationCronTick: vi.fn(),
  runInstantlyImportTick: vi.fn(),
}));

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceOwner: mocks.requireWorkspaceOwner,
}));
vi.mock("@/infrastructure/neon/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getApifyRecoverySnapshot: mocks.getApifyRecoverySnapshot }));
vi.mock("@/infrastructure/neon/repositories/productivity-diagnostics", () => ({ getProductivityDiagnostics: mocks.getProductivityDiagnostics }));
vi.mock("@/infrastructure/neon/repositories/production-capacity-diagnostics", () => ({ getProductionCapacityDiagnostics: mocks.getProductionCapacityDiagnostics }));
vi.mock("@/infrastructure/neon/repositories/health-diagnostics", () => ({ getSystemHealthDiagnostics: mocks.getSystemHealthDiagnostics }));
vi.mock("@/lib/config/env", () => ({
  getMapsEnv: mocks.getMapsEnv,
  getSerperEnv: mocks.getSerperEnv,
  getDeliveryEnv: mocks.getDeliveryEnv,
}));
vi.mock("@/services/discovery/provider-health", () => ({ buildProviderHealthSnapshot: mocks.buildProviderHealthSnapshot }));
vi.mock("@/infrastructure/jobs/runners/autopilot-runner", () => ({ runAutopilotCronTick: mocks.runAutopilotCronTick }));
vi.mock("@/infrastructure/jobs/runners/discovery-runner", () => ({ runDiscoveryCronTick: mocks.runDiscoveryCronTick }));
vi.mock("@/infrastructure/jobs/runners/provider-runs-runner", () => ({ runProviderRunsCronTick: mocks.runProviderRunsCronTick }));
vi.mock("@/infrastructure/jobs/runners/processing-runner", () => ({ runProcessingCronTick: mocks.runProcessingCronTick }));
vi.mock("@/infrastructure/jobs/runners/watchdog-runner", () => ({ refreshWatchdogPauseForWorkspace: mocks.refreshWatchdogPauseForWorkspace }));
vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({
  enqueueVerificationJobs: mocks.enqueueVerificationJobs,
  runVerificationCronTick: mocks.runVerificationCronTick,
}));
vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({ runInstantlyImportTick: mocks.runInstantlyImportTick }));

const { POST } = await import("./route");

describe("/api/admin/run-pipeline-cycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1", role: "owner" });
    mocks.getApifyRecoverySnapshot.mockResolvedValue({
      recoveryProbeEligible: true,
      recoveryProbeInFlight: false,
      nextRecoveryAttemptAt: null,
      latestFailureKind: "transient",
      latestFailureAt: new Date("2026-10-20T00:00:00.000Z"),
      latestSuccessAt: null,
      safetyBlocked: false,
    });
    mocks.getProductivityDiagnostics
      .mockResolvedValueOnce({ timezone: "Europe/Madrid", instantlyToday: { eligibleAccounts: 1 } })
      .mockResolvedValueOnce({ timezone: "Europe/Madrid", instantlyToday: { eligibleAccounts: 2 } });
    mocks.getProductionCapacityDiagnostics.mockResolvedValue({
      instantly: { currentLeads: 432, effectiveContactHardLimit: 1000, remainingLeads: 568, currentMonthlySendHeadroom: 4520 },
    });
    mocks.getSystemHealthDiagnostics.mockResolvedValue({
      providers: { apify: { budgetAllowed: true, recentTerminalCalls: 4, recentErrors: 1 } },
    });
    mocks.getMapsEnv.mockReturnValue({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "configured", APIFY_DAILY_COST_LIMIT_USD: 15 });
    mocks.getSerperEnv.mockReturnValue({ SERPER_DAILY_COST_LIMIT_USD: 0.5 });
    mocks.getDeliveryEnv.mockReturnValue({ INSTANTLY_CAMPAIGN_ID: "055534c5-c3e3-414f-b140-f4770b293c00" });
    mocks.buildProviderHealthSnapshot.mockReturnValue({
      allocationHealth: "paused",
      providerAvailable: false,
      budgetAllowed: true,
      recoveredAfterLatestFailure: false,
    });
    mocks.getDb.mockReturnValue({ execute: vi.fn()
      .mockResolvedValueOnce({ rows: [{ raw_new: 2, processed_new: 1, email_new: 1 }] })
      .mockResolvedValueOnce({ rows: [{ contacts: 3 }] }) });
    mocks.runInstantlyImportTick
      .mockResolvedValueOnce({ leadsAdded: 1, candidatesFound: 1, leadsQueued: 0, leadsFailed: 0, leadsNeedsReconciliation: 0 })
      .mockResolvedValueOnce({ leadsAdded: 1, candidatesFound: 1, leadsQueued: 0, leadsFailed: 0, leadsNeedsReconciliation: 0 });
    mocks.runAutopilotCronTick.mockResolvedValue({ ordersScheduled: 10 });
    mocks.runDiscoveryCronTick.mockResolvedValue({ jobsClaimed: 1, rawCandidatesProduced: 1, rawCandidatesInserted: 1, rawCandidatesDuplicate: 0 });
    mocks.runProviderRunsCronTick.mockResolvedValue({
      runsChecked: 1,
      itemsReturned: 2,
      ingestionAccounting: {
        INSERTED_NEW_RAW: 1,
        DUPLICATE_EXISTING_RAW: 1,
        CANONICAL_DEDUPE: 0,
        INVALID_OR_UNMAPPABLE: 0,
        FILTERED_BY_POLICY: 0,
        FAILED_INSERT: 0,
        UNKNOWN: 0,
      },
      warnings: [],
    });
    mocks.runProcessingCronTick.mockResolvedValue({ jobsCompleted: 1 });
    mocks.refreshWatchdogPauseForWorkspace.mockResolvedValue(undefined);
    mocks.enqueueVerificationJobs.mockResolvedValue(1);
    mocks.runVerificationCronTick.mockResolvedValue({ emailsVerified: 1, verificationValid: 1 });
  });

  it("requires an authenticated workspace owner before running any step", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    mocks.requireWorkspaceOwner.mockRejectedValue(new UnauthorizedError());

    const response = await POST();

    expect(response.status).toBe(403);
    expect(mocks.runAutopilotCronTick).not.toHaveBeenCalled();
    expect(mocks.runInstantlyImportTick).not.toHaveBeenCalled();
    expect(mocks.refreshWatchdogPauseForWorkspace).not.toHaveBeenCalled();
  });

  it("reports the failed stage and logs only approved safe metadata", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("private SQL and contact details"), {
      code: "23503",
      constraint: "fk_verification_jobs_contact_points",
    });
    mocks.runVerificationCronTick.mockImplementationOnce(async (_maxJobs, options) => {
      options.onStage("VERIFICATION_PROVIDER");
      throw failure;
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      stage: "VERIFICATION_PROVIDER",
      sqlState: "23503",
      constraintName: "fk_verification_jobs_contact_points",
      errorClass: "Error",
    });
    expect(JSON.stringify(body)).not.toContain("private SQL");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]?.[0]).toBe("pipeline_cycle_failed");
    expect(logSpy.mock.calls[0]?.[1]).toEqual({
      stage: "VERIFICATION_PROVIDER",
      sqlState: "23503",
      errorClass: "Error",
      constraintName: "fk_verification_jobs_contact_points",
      elapsedMs: expect.any(Number),
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(logSpy.mock.calls[0])).not.toContain("private SQL");
    logSpy.mockRestore();
  });

  it("keeps verification enqueue failures distinct from verification claims", async () => {
    mocks.enqueueVerificationJobs.mockRejectedValueOnce(new Error("private query detail"));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.stage).toBe("VERIFICATION");
    expect(JSON.stringify(body)).not.toContain("private query detail");
    expect(mocks.runVerificationCronTick).not.toHaveBeenCalled();
  });

  it("runs one bounded cycle and returns aggregate-only counters", async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "completed",
      cycleCount: 1,
      discoveryRequested: 10,
      providerItemsReturned: 2,
      returnedAccounted: 2,
      returnedUnexplained: 0,
      rawNew: 2,
      processedNew: 1,
      emailNew: 1,
      verificationValidNew: 1,
      eligibleNew: 1,
      existingEligibleDrained: 1,
      instantlyNew: 2,
      cumulativeInstantlyNewToday: 3,
      instantlyAvailableSlots: 568,
      monthlyEmailHeadroom: 4520,
      autoSendEnabled: false,
    });
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledTimes(2);
    expect(mocks.refreshWatchdogPauseForWorkspace).toHaveBeenCalledOnce();
    expect(mocks.refreshWatchdogPauseForWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(mocks.runInstantlyImportTick.mock.invocationCallOrder[0]!).toBeLessThan(mocks.refreshWatchdogPauseForWorkspace.mock.invocationCallOrder[0]!);
    expect(mocks.refreshWatchdogPauseForWorkspace.mock.invocationCallOrder[0]!).toBeLessThan(mocks.runAutopilotCronTick.mock.invocationCallOrder[0]!);
    expect(mocks.runAutopilotCronTick).toHaveBeenCalledOnce();
    expect(mocks.runDiscoveryCronTick).toHaveBeenCalledOnce();
    expect(mocks.runProviderRunsCronTick).toHaveBeenCalledWith(5);
    expect(mocks.runProcessingCronTick).toHaveBeenCalledOnce();
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(10, expect.objectContaining({ skipInstantlyImport: true }));
    expect(JSON.stringify(body)).not.toContain("configured");
  });
});