import { beforeEach, describe, expect, it, vi } from "vitest";
import { MULTI_NICHE_ROLLOUT } from "@/services/autopilot/multi-niche-rollout";

const mocks = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  getWorkspaceRole: vi.fn(),
  requireCurrentUser: vi.fn(),
  getCampaignById: vi.fn(),
  getProductionCapacityDiagnostics: vi.fn(),
  getScopedInstantlyTargetPreflight: vi.fn(),
  getAutopilotSettings: vi.fn(),
  getTodaySpendUsd: vi.fn(),
  getMultiNicheCampaignInventory: vi.fn(),
  getScopedCampaignProviderSpend: vi.fn(),
  listSearchSeedsForCampaignEngine: vi.fn(),
  getSeedEconomicPerformance: vi.fn(),
  enqueueDiscoveryJob: vi.fn(),
  enqueueScopedSmokeJob: vi.fn(),
  getScopedSmokeJob: vi.fn(),
  persistScopedSmokeResult: vi.fn(),
  lastEnqueueTimestamp: 0,
  runDiscoveryCronTick: vi.fn(),
  runProviderRunsCronTick: vi.fn(),
  runProcessingCronTick: vi.fn(),
  enqueueVerificationJobs: vi.fn(),
  runVerificationCronTick: vi.fn(),
  buildEngineCapabilities: vi.fn(),
  routeCampaignsToAvailableEngines: vi.fn(),
  getMapsEnv: vi.fn(),
  getSerperEnv: vi.fn(),
  getVerificationEnv: vi.fn(),
  getEffectiveAutopilotState: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  getCurrentWorkspaceId: mocks.getCurrentWorkspaceId,
  requireCurrentUser: mocks.requireCurrentUser,
}));
vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ getWorkspaceRole: mocks.getWorkspaceRole }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ getCampaignById: mocks.getCampaignById }));
vi.mock("@/infrastructure/neon/repositories/production-capacity-diagnostics", () => ({ getProductionCapacityDiagnostics: mocks.getProductionCapacityDiagnostics }));
vi.mock("@/infrastructure/neon/repositories/instantly-import-targets", () => ({ getScopedInstantlyTargetPreflight: mocks.getScopedInstantlyTargetPreflight }));
vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({ getAutopilotSettings: mocks.getAutopilotSettings }));
vi.mock("@/infrastructure/neon/repositories/provider-runs", () => ({ getTodaySpendUsd: mocks.getTodaySpendUsd }));
vi.mock("@/infrastructure/neon/repositories/multi-niche-rollout", () => ({
  getMultiNicheCampaignInventory: mocks.getMultiNicheCampaignInventory,
  getScopedCampaignProviderSpend: mocks.getScopedCampaignProviderSpend,
}));
vi.mock("@/infrastructure/neon/repositories/discovery", () => ({
  listSearchSeedsForCampaignEngine: mocks.listSearchSeedsForCampaignEngine,
  getSeedEconomicPerformance: mocks.getSeedEconomicPerformance,
}));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  enqueueDiscoveryJob: mocks.enqueueDiscoveryJob,
  enqueueScopedSmokeJob: mocks.enqueueScopedSmokeJob,
  getScopedSmokeJob: mocks.getScopedSmokeJob,
  persistScopedSmokeResult: mocks.persistScopedSmokeResult,
}));
vi.mock("@/infrastructure/jobs/runners/discovery-runner", () => ({ runDiscoveryCronTick: mocks.runDiscoveryCronTick }));
vi.mock("@/infrastructure/jobs/runners/provider-runs-runner", () => ({ runProviderRunsCronTick: mocks.runProviderRunsCronTick }));
vi.mock("@/infrastructure/jobs/runners/processing-runner", () => ({ runProcessingCronTick: mocks.runProcessingCronTick }));
vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({ enqueueVerificationJobs: mocks.enqueueVerificationJobs, runVerificationCronTick: mocks.runVerificationCronTick }));
vi.mock("@/services/autopilot/engine-capability", () => ({ buildEngineCapabilities: mocks.buildEngineCapabilities }));
vi.mock("@/services/autopilot/target-planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/autopilot/target-planner")>();
  return {
    ...actual,
    planningWindowKey: vi.fn(() => "2026-10-14"),
    routeCampaignsToAvailableEngines: mocks.routeCampaignsToAvailableEngines,
  };
});
vi.mock("@/lib/config/env", () => ({ getMapsEnv: mocks.getMapsEnv, getSerperEnv: mocks.getSerperEnv, getVerificationEnv: mocks.getVerificationEnv }));
vi.mock("@/domain/autopilot/types", () => ({ getEffectiveAutopilotState: mocks.getEffectiveAutopilotState }));
vi.mock("@/lib/observability/structured-logger", () => ({ logEvent: mocks.logEvent }));

const { POST } = await import("./route");

function request(body: unknown) {
  return new Request("http://localhost/api/admin/discovery/scoped-smoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function realSmokeRequest(campaignId: string, extra: Record<string, unknown> = {}) {
  return request({
    campaignId,
    dryRun: false,
    maxDiscoveryJobs: 1,
    maxProviderQueries: 1,
    maxCandidates: 5,
    probeMode: true,
    smokeExecutionId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
    allowImport: false,
    ...extra,
  });
}

describe("POST /api/admin/discovery/scoped-smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentUser.mockResolvedValue({ userId: "admin-1" });
    mocks.getCurrentWorkspaceId.mockResolvedValue("workspace-1");
    mocks.getWorkspaceRole.mockResolvedValue("admin");
    mocks.getCampaignById.mockImplementation(async (campaignId: string) => {
      const entry = MULTI_NICHE_ROLLOUT.find((item) => item.campaignId === campaignId)!;
      return {
        id: entry.campaignId,
        workspaceId: "workspace-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "draft",
        autopilotEnabled: false,
        timeZone: "Europe/Madrid",
        engineConfig: { niche: entry.niche },
      };
    });
    mocks.getProductionCapacityDiagnostics.mockResolvedValue({
      operationalTarget: { operationalDailyTarget: 4 },
      providerHealth: {
        apify: { reliability: "healthy", budgetAllowed: true },
        serper: { reliability: "healthy", budgetAllowed: true },
      },
    });
    mocks.getScopedInstantlyTargetPreflight.mockImplementation(async (campaignId: string) => {
      const entry = MULTI_NICHE_ROLLOUT.find((item) => item.campaignId === campaignId)!;
      return {
        niche: entry.niche,
        expectedTarget: entry.expectedTarget,
        actualTarget: entry.expectedTarget,
        mappingEnabled: false,
        importReady: false,
        blockReason: "mapping_disabled",
      };
    });
    mocks.getAutopilotSettings.mockResolvedValue({ timezone: "Europe/Madrid", globalDailyTarget: 250 });
    mocks.getTodaySpendUsd.mockResolvedValue(0);
    mocks.getMultiNicheCampaignInventory.mockResolvedValue(MULTI_NICHE_ROLLOUT.map((entry) => ({
      campaignId: entry.campaignId,
      rawRequestedToday: 0,
      backlogInventory: 0,
      confirmedImports: 0,
      completedProbeCount: 0,
    })));
    mocks.getScopedCampaignProviderSpend.mockResolvedValue(0.02);
    mocks.getSeedEconomicPerformance.mockResolvedValue(new Map());
    mocks.listSearchSeedsForCampaignEngine.mockImplementation(async (campaignId: string, engineType: string) => [{
      id: "seed-1",
      campaignId,
      engineType,
      query: "yoga studio",
      geography: "Madrid",
      nextEligibleAt: null,
      lastRunAt: null,
    }]);
    mocks.enqueueDiscoveryJob.mockResolvedValue("job-1");
    mocks.enqueueScopedSmokeJob.mockImplementation(async ({ jobId, campaignId, payload }: { jobId: string; campaignId: string; payload: Record<string, unknown> }) => ({
      created: true,
      job: (() => {
        mocks.lastEnqueueTimestamp = Date.now();
        return {
          id: jobId,
          campaignId,
          payload,
          status: "pending",
          attemptCount: 0,
          idempotencyKey: `scoped-smoke:${campaignId}:${jobId}`,
          lastError: null,
        };
      })(),
    }));
    mocks.getScopedSmokeJob.mockResolvedValue(null);
    mocks.persistScopedSmokeResult.mockResolvedValue(undefined);
    mocks.runDiscoveryCronTick.mockResolvedValue({
      jobsClaimed: 1,
      rawCandidatesInserted: 2,
      scopedProbeEvidence: {
        jobClaimed: true,
        providerCallAttempted: true,
        providerCallSucceeded: true,
        providerCallErrorClass: null,
        providerQueriesUsed: 1,
        resultsReturned: 3,
        rawCandidatesInserted: 2,
        duplicates: 1,
        candidateCount: 2,
      },
    });
    mocks.runProviderRunsCronTick.mockResolvedValue({ runsChecked: 1, runsIngested: 0, candidatesInserted: 0 });
    mocks.runProcessingCronTick.mockResolvedValue({ jobsCompleted: 0 });
    mocks.enqueueVerificationJobs.mockResolvedValue({ queued: 0 });
    mocks.runVerificationCronTick.mockResolvedValue({ jobsClaimed: 0, millionVerifierStatus: "ready" });
    mocks.buildEngineCapabilities.mockReturnValue([{ engineType: "maps_fast", available: true, providerUntested: false }]);
    mocks.routeCampaignsToAvailableEngines.mockImplementation((campaigns: unknown[]) => [{ ...(campaigns[0] as object), engineType: "maps_fast" }]);
    mocks.getMapsEnv.mockReturnValue({ MAPS_PROVIDER: "apify", APIFY_API_TOKEN: "configured" });
    mocks.getSerperEnv.mockReturnValue({ SERP_PROVIDER: "serper", SERPER_API_KEY: "configured" });
    mocks.getVerificationEnv.mockReturnValue({
      EMAIL_VERIFICATION_PROVIDER: "millionverifier",
      MILLION_VERIFIER: "configured",
      MILLIONVERIFIER_API_KEY: "configured",
      EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD: 1,
    });
    mocks.getEffectiveAutopilotState.mockReturnValue("running");
  });

  it("requires authentication and an admin role", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    mocks.requireCurrentUser.mockRejectedValueOnce(new UnauthorizedError());
    expect((await POST(request({ campaignId: MULTI_NICHE_ROLLOUT[0].campaignId }))).status).toBe(401);

    mocks.requireCurrentUser.mockResolvedValue({ userId: "member-1" });
    mocks.getWorkspaceRole.mockResolvedValue("member");
    expect((await POST(request({ campaignId: MULTI_NICHE_ROLLOUT[0].campaignId }))).status).toBe(403);
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
  });

  it.each(MULTI_NICHE_ROLLOUT)("returns a read-only dry-run for $niche", async (entry) => {
    const response = await POST(request({ campaignId: entry.campaignId }));
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      SOURCE_CAMPAIGN_ID: entry.campaignId,
      NICHE: entry.niche,
      EXPECTED_INSTANTLY_TARGET: entry.expectedTarget,
      PROVIDER: "apify",
      PROVIDER_ENGINE: "maps_fast",
      COLD_START: true,
      SELECTION_REASON: "never_run_seed",
      SEED_ID: "seed-1",
      SEED_QUERY: "yoga studio",
      GEOGRAPHY: "Madrid",
      IMPORT_BLOCKED: true,
      LEGACY_FALLBACK_USED: false,
      GLOBAL_SIDE_EFFECTS: false,
      OPERATIONAL_ENVELOPE: expect.objectContaining({
        scope: "multi_niche_rollout_global",
        businessTarget: 250,
        operationalTarget: 4,
        effectiveSchedulerTarget: 4,
        campaignIds: MULTI_NICHE_ROLLOUT.map((item) => item.campaignId),
      }),
      COLD_START_POLICY: {
        enabled: true,
        minimumConfirmedImportsBeforeEconomicAllocation: 5,
        permanentEqualShare: false,
      },
    });
    expect(mocks.enqueueDiscoveryJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
    expect(mocks.runProviderRunsCronTick).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).not.toHaveBeenCalled();
  });

  it("rejects imports, unallowlisted campaigns, and incorrect mapping targets", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    expect((await POST(request({ campaignId, allowImport: true }))).status).toBe(400);
    expect((await POST(realSmokeRequest(campaignId, { allowImport: true }))).status).toBe(400);
    expect((await POST(realSmokeRequest(campaignId, { maxProviderQueries: 2 }))).status).toBe(400);
    expect((await POST(realSmokeRequest(campaignId, { probeMode: false }))).status).toBe(400);
    expect((await POST(request({ campaignId: "65b9f85d-4c8b-4e52-99fb-217eb3acac1d" }))).status).toBe(403);
    for (const farmaciasCampaignId of [
      "9d1a2c44-924d-4295-9564-3f203cf14c79",
      "288fc3b6-92ef-48ec-a0fd-76612620cd44",
      "747d5b86-4196-4e23-986e-fa12df442d36",
    ]) {
      expect((await POST(realSmokeRequest(farmaciasCampaignId))).status).toBe(403);
    }
    mocks.getScopedInstantlyTargetPreflight.mockResolvedValueOnce({
      niche: "yoga_pilates",
      expectedTarget: "unexpected",
      actualTarget: "unexpected",
      mappingEnabled: false,
      importReady: false,
      blockReason: "mapping_disabled",
    });
    expect((await POST(request({ campaignId }))).status).toBe(409);
  });

  it("claims and executes one exact bounded campaign job with import disabled", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const response = await POST(realSmokeRequest(campaignId));
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.providerSpendUsd).toBe(0.02);
    expect(payload).toMatchObject({
      SMOKE_EXECUTION_ID: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
      JOB_ID: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
      JOB_CLAIMED: true,
      PROVIDER_CALL_ATTEMPTED: true,
      PROVIDER_CALL_SUCCEEDED: true,
      PROVIDER_QUERIES_USED: 1,
      RESULTS_RETURNED: 3,
      RAW_CANDIDATES_INSERTED: 2,
      DUPLICATES: 1,
      CANDIDATE_COUNT: 2,
      IMPORT_ALLOWED: false,
      IMPORT_BLOCKED: true,
      AUTO_SEND_ENABLED: false,
    });
    expect(mocks.enqueueScopedSmokeJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
      campaignId,
      payload: expect.objectContaining({
        desiredRawCount: 5,
        maxCandidates: 5,
        maxProviderQueries: 1,
        probeMode: true,
        seedId: "seed-1",
      }),
    }));
    expect(mocks.runDiscoveryCronTick).toHaveBeenCalledWith(1, expect.any(Date), {
      campaignId,
      jobId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
      allowScopedDraftCampaign: true,
      probeMode: true,
      smokeExecutionId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
    });
    expect(mocks.runDiscoveryCronTick.mock.calls[0]?.[1].getTime()).toBeGreaterThanOrEqual(mocks.lastEnqueueTimestamp);
    expect(mocks.runProviderRunsCronTick).toHaveBeenCalledWith(1, { campaignId, discoveryJobId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c" });
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(2, expect.any(Date), expect.objectContaining({ campaignId }));
    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith(expect.objectContaining({
      campaignId,
      allowScopedDraftCampaign: true,
      batchSize: 2,
    }));
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(2, expect.objectContaining({
      campaignId,
      allowScopedDraftCampaign: true,
      skipInstantlyImport: true,
    }));
    expect(mocks.persistScopedSmokeResult).toHaveBeenCalledTimes(1);
  });

  it("continues bounded execution while reporting unavailable verification", async () => {
    mocks.getVerificationEnv.mockReturnValue({
      EMAIL_VERIFICATION_PROVIDER: "disabled",
      EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD: 1,
    });
    mocks.runVerificationCronTick.mockResolvedValueOnce({ jobsClaimed: 0, millionVerifierStatus: "disabled" });
    const response = await POST(realSmokeRequest(MULTI_NICHE_ROLLOUT[0].campaignId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.verification.millionVerifierStatus).toBe("disabled");
    expect(mocks.runProcessingCronTick).toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).toHaveBeenCalled();
    expect(mocks.enqueueScopedSmokeJob).toHaveBeenCalledTimes(1);
  });

  it("rejects a real smoke when both discovery providers are unavailable", async () => {
    mocks.buildEngineCapabilities.mockReturnValue([
      { engineType: "maps_fast", available: false, providerUntested: false },
      { engineType: "google_serp", available: false, providerUntested: false },
    ]);
    const response = await POST(realSmokeRequest(MULTI_NICHE_ROLLOUT[0].campaignId));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(mocks.enqueueDiscoveryJob).not.toHaveBeenCalled();
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
    expect(mocks.runProviderRunsCronTick).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).not.toHaveBeenCalled();
  });

  it("returns the persisted result on the same execution ID without repeating side effects", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const smokeExecutionId = "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c";
    const savedResult = {
      ok: true,
      dryRun: false,
      SMOKE_EXECUTION_ID: smokeExecutionId,
      JOB_ID: smokeExecutionId,
      JOB_CLAIMED: true,
      PROVIDER_CALL_ATTEMPTED: true,
      PROVIDER_CALL_SUCCEEDED: true,
      PROVIDER_QUERIES_USED: 1,
      RESULTS_RETURNED: 0,
      RAW_CANDIDATES_INSERTED: 0,
      CANDIDATE_COUNT: 0,
      IMPORT_ALLOWED: false,
      IMPORT_BLOCKED: true,
      AUTO_SEND_ENABLED: false,
    };
    mocks.getScopedSmokeJob.mockResolvedValueOnce({
      id: smokeExecutionId,
      campaignId,
      payload: { smokeExecutionId, scopedSmokeResult: savedResult },
      status: "completed",
      attemptCount: 1,
      idempotencyKey: `scoped-smoke:${campaignId}:${smokeExecutionId}`,
      lastError: null,
    });

    const response = await POST(realSmokeRequest(campaignId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ...savedResult, IDEMPOTENT_REPLAY: true });
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).not.toHaveBeenCalled();
  });

  it("reports scoped provider spend when replaying evidence without a saved final result", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const smokeExecutionId = "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c";
    mocks.getScopedSmokeJob.mockResolvedValueOnce({
      id: smokeExecutionId,
      campaignId,
      payload: {
        smokeExecutionId,
        startedAt: "2026-10-18T08:59:00.000Z",
        scopedSmokeEvidence: {
          jobClaimed: true,
          providerCallAttempted: true,
          providerCallSucceeded: false,
          providerQueriesUsed: 1,
          resultsReturned: 0,
          rawCandidatesInserted: 0,
          candidateCount: 0,
        },
      },
      status: "processing",
      attemptCount: 1,
      idempotencyKey: `scoped-smoke:${campaignId}:${smokeExecutionId}`,
      lastError: null,
    });

    const response = await POST(realSmokeRequest(campaignId));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      IDEMPOTENT_REPLAY: true,
      PROVIDER_CALL_ATTEMPTED: true,
      PROVIDER_CALL_SUCCEEDED: false,
      PROVIDER_SPEND_USD: 0.02,
    });
    expect(mocks.getScopedCampaignProviderSpend).toHaveBeenCalledWith(campaignId, new Date("2026-10-18T08:59:00.000Z"));
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("rejects a pending execution ID when retry options differ from its persisted job", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const smokeExecutionId = "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c";
    mocks.getScopedSmokeJob.mockResolvedValueOnce({
      id: smokeExecutionId,
      campaignId,
      payload: {
        smokeExecutionId,
        engineType: "maps_fast",
        seedId: "seed-1",
        maxCandidates: 2,
        maxProviderQueries: 1,
        probeMode: true,
        scopedSmoke: true,
      },
      status: "pending",
      attemptCount: 0,
      idempotencyKey: `scoped-smoke:${campaignId}:${smokeExecutionId}`,
      lastError: null,
    });

    const response = await POST(realSmokeRequest(campaignId));

    expect(response.status).toBe(409);
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("rejects an execution ID already bound to another campaign", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[1].campaignId;
    const smokeExecutionId = "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c";
    mocks.getScopedSmokeJob.mockResolvedValueOnce({
      id: smokeExecutionId,
      campaignId: MULTI_NICHE_ROLLOUT[0].campaignId,
      payload: { smokeExecutionId },
      status: "pending",
      attemptCount: 0,
      idempotencyKey: `scoped-smoke:${MULTI_NICHE_ROLLOUT[0].campaignId}:${smokeExecutionId}`,
      lastError: null,
    });

    expect((await POST(realSmokeRequest(campaignId))).status).toBe(409);
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("rejects a retry if the persisted seed query or geography changed", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const smokeExecutionId = "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c";
    mocks.getScopedSmokeJob.mockResolvedValueOnce({
      id: smokeExecutionId,
      campaignId,
      payload: {
        smokeExecutionId,
        engineType: "maps_fast",
        seedId: "seed-1",
        seedQuery: "previous query",
        seedGeography: "Madrid",
        maxCandidates: 5,
        maxProviderQueries: 1,
        probeMode: true,
        scopedSmoke: true,
      },
      status: "pending",
      attemptCount: 0,
      idempotencyKey: `scoped-smoke:${campaignId}:${smokeExecutionId}`,
      lastError: null,
    });

    expect((await POST(realSmokeRequest(campaignId))).status).toBe(409);
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("supports a separately identified intentional probe", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const smokeExecutionId = "5a293100-2b9e-4e93-9702-f51278dd43f2";
    const response = await POST(realSmokeRequest(campaignId, { smokeExecutionId }));

    expect(response.status).toBe(200);
    expect(mocks.enqueueScopedSmokeJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: smokeExecutionId }));
    expect(mocks.runDiscoveryCronTick).toHaveBeenCalledWith(1, expect.any(Date), expect.objectContaining({
      jobId: smokeExecutionId,
      smokeExecutionId,
      probeMode: true,
    }));
  });

  it("refuses a seed still inside cooldown before enqueue or provider execution", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    mocks.listSearchSeedsForCampaignEngine.mockImplementation(async (seedCampaignId: string, engineType: string) => [{
      id: "cooling-seed",
      campaignId: seedCampaignId,
      engineType,
      query: "yoga studio",
      geography: "Madrid",
      nextEligibleAt: new Date(Date.now() + 60_000).toISOString(),
      lastRunAt: new Date().toISOString(),
    }]);

    expect((await POST(realSmokeRequest(campaignId))).status).toBe(409);
    expect(mocks.enqueueScopedSmokeJob).not.toHaveBeenCalled();
    expect(mocks.runDiscoveryCronTick).not.toHaveBeenCalled();
  });
});
