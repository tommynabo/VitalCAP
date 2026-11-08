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
  getScopedCampaignProviderSpend: vi.fn(),
  listSearchSeedsForCampaignEngine: vi.fn(),
  enqueueDiscoveryJob: vi.fn(),
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
vi.mock("@/infrastructure/neon/repositories/multi-niche-rollout", () => ({ getScopedCampaignProviderSpend: mocks.getScopedCampaignProviderSpend }));
vi.mock("@/infrastructure/neon/repositories/discovery", () => ({ listSearchSeedsForCampaignEngine: mocks.listSearchSeedsForCampaignEngine }));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({ enqueueDiscoveryJob: mocks.enqueueDiscoveryJob }));
vi.mock("@/infrastructure/jobs/runners/discovery-runner", () => ({ runDiscoveryCronTick: mocks.runDiscoveryCronTick }));
vi.mock("@/infrastructure/jobs/runners/provider-runs-runner", () => ({ runProviderRunsCronTick: mocks.runProviderRunsCronTick }));
vi.mock("@/infrastructure/jobs/runners/processing-runner", () => ({ runProcessingCronTick: mocks.runProcessingCronTick }));
vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({ enqueueVerificationJobs: mocks.enqueueVerificationJobs, runVerificationCronTick: mocks.runVerificationCronTick }));
vi.mock("@/services/autopilot/engine-capability", () => ({ buildEngineCapabilities: mocks.buildEngineCapabilities }));
vi.mock("@/services/autopilot/target-planner", () => ({ planningWindowKey: vi.fn(() => "2026-10-14"), routeCampaignsToAvailableEngines: mocks.routeCampaignsToAvailableEngines }));
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
        status: "draft",
        autopilotEnabled: false,
        timeZone: "Europe/Madrid",
        engineConfig: { niche: entry.niche },
      };
    });
    mocks.getProductionCapacityDiagnostics.mockResolvedValue({
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
    mocks.getAutopilotSettings.mockResolvedValue({ timezone: "Europe/Madrid" });
    mocks.getTodaySpendUsd.mockResolvedValue(0);
    mocks.getScopedCampaignProviderSpend.mockResolvedValue(0.02);
    mocks.listSearchSeedsForCampaignEngine.mockResolvedValue([{ id: "seed-1", query: "yoga studio", geography: "Madrid", nextEligibleAt: null, lastRunAt: null }]);
    mocks.enqueueDiscoveryJob.mockResolvedValue("job-1");
    mocks.runDiscoveryCronTick.mockResolvedValue({ jobsClaimed: 1, rawCandidatesInserted: 0 });
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

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      SOURCE_CAMPAIGN_ID: entry.campaignId,
      NICHE: entry.niche,
      EXPECTED_INSTANTLY_TARGET: entry.expectedTarget,
      PROVIDER: "apify",
      PROVIDER_ENGINE: "maps_fast",
      IMPORT_BLOCKED: true,
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
    expect((await POST(request({ campaignId: "65b9f85d-4c8b-4e52-99fb-217eb3acac1d" }))).status).toBe(403);
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

  it("runs only the bounded campaign and discovery-job scope with import disabled", async () => {
    const campaignId = MULTI_NICHE_ROLLOUT[0].campaignId;
    const response = await POST(request({ campaignId, dryRun: false, maxCandidates: 5 }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.providerSpendUsd).toBe(0.02);
    expect(mocks.enqueueDiscoveryJob).toHaveBeenCalledWith(expect.objectContaining({
      campaignId,
      payload: expect.objectContaining({ desiredRawCount: 5, scopedSmoke: true }),
    }));
    expect(mocks.runDiscoveryCronTick).toHaveBeenCalledWith(1, expect.any(Date), {
      campaignId,
      jobId: "job-1",
      allowScopedDraftCampaign: true,
    });
    expect(mocks.runProviderRunsCronTick).toHaveBeenCalledWith(1, { campaignId, discoveryJobId: "job-1" });
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(5, expect.any(Date), expect.objectContaining({ campaignId }));
    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith(expect.objectContaining({
      campaignId,
      allowScopedDraftCampaign: true,
      batchSize: 5,
    }));
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(5, expect.objectContaining({
      campaignId,
      allowScopedDraftCampaign: true,
      skipInstantlyImport: true,
    }));
  });

  it("continues bounded execution while reporting unavailable verification", async () => {
    mocks.getVerificationEnv.mockReturnValue({
      EMAIL_VERIFICATION_PROVIDER: "disabled",
      EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD: 1,
    });
    mocks.runVerificationCronTick.mockResolvedValueOnce({ jobsClaimed: 0, millionVerifierStatus: "disabled" });
    const response = await POST(request({ campaignId: MULTI_NICHE_ROLLOUT[0].campaignId, dryRun: false }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.verification.millionVerifierStatus).toBe("disabled");
    expect(mocks.runProcessingCronTick).toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).toHaveBeenCalled();
    expect(mocks.enqueueDiscoveryJob).toHaveBeenCalledTimes(1);
  });

  it("continues scoped backlog processing when both discovery providers are unavailable", async () => {
    mocks.buildEngineCapabilities.mockReturnValue([
      { engineType: "maps_fast", available: false, providerUntested: false },
      { engineType: "google_serp", available: false, providerUntested: false },
    ]);
    const response = await POST(request({ campaignId: MULTI_NICHE_ROLLOUT[0].campaignId, dryRun: false }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      discovery: null,
      discoverySkippedReason: "No discovery provider is available; scoped backlog processing and verification still ran.",
    });
    expect(mocks.enqueueDiscoveryJob).not.toHaveBeenCalled();
    expect(mocks.runProviderRunsCronTick).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(3, expect.any(Date), expect.objectContaining({
      campaignId: MULTI_NICHE_ROLLOUT[0].campaignId,
      enrichContacts: true,
    }));
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(3, expect.objectContaining({
      campaignId: MULTI_NICHE_ROLLOUT[0].campaignId,
      skipInstantlyImport: true,
    }));
  });
});
