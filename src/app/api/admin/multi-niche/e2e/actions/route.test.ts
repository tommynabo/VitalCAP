import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceAdmin: vi.fn(),
  getRawCandidateById: vi.fn(),
  getCampaignById: vi.fn(),
  execute: vi.fn(),
  enqueueAdminScopedProcessingJob: vi.fn(),
  getScopedDraftInstantlyImportTarget: vi.fn(),
  runProcessingCronTick: vi.fn(),
  runVerificationCronTick: vi.fn(),
  runAdminScopedDraftInstantlyImport: vi.fn(),
}));

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceAdmin: mocks.requireWorkspaceAdmin,
}));
vi.mock("@/infrastructure/neon/repositories/discovery", () => ({ getRawCandidateById: mocks.getRawCandidateById }));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ getCampaignById: mocks.getCampaignById }));
vi.mock("@/infrastructure/neon/db", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  enqueueAdminScopedProcessingJob: mocks.enqueueAdminScopedProcessingJob,
}));
vi.mock("@/infrastructure/neon/repositories/instantly-import-targets", () => ({
  getScopedDraftInstantlyImportTarget: mocks.getScopedDraftInstantlyImportTarget,
}));
vi.mock("@/infrastructure/jobs/runners/processing-runner", () => ({ runProcessingCronTick: mocks.runProcessingCronTick }));
vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({ runVerificationCronTick: mocks.runVerificationCronTick }));
vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({
  runAdminScopedDraftInstantlyImport: mocks.runAdminScopedDraftInstantlyImport,
}));

const { POST } = await import("./route");

const campaignId = "65b9f85d-4c8b-4e52-99fb-217eb3acac1c";
const rawCandidateId = "8e91fd3d-3d3d-4d19-a20c-831debd63965";
const contactPointId = "6b733089-32c8-4690-9e83-5c0db7734bb6";

function request(body: unknown) {
  return new Request("https://example.test/api/admin/multi-niche/e2e/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<Response> {
  const response = await POST!(request(body));
  if (!response) throw new Error("Admin E2E route returned no response.");
  return response;
}

describe("POST /api/admin/multi-niche/e2e/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceAdmin.mockResolvedValue({ workspaceId: "workspace-1", role: "admin" });
    mocks.getCampaignById.mockResolvedValue({
      id: campaignId,
      workspaceId: "workspace-1",
      status: "draft",
      autopilotEnabled: false,
      engineConfig: { niche: "yoga_pilates" },
    });
    mocks.getScopedDraftInstantlyImportTarget.mockResolvedValue({
      target: { campaignId, workspaceId: "workspace-1", providerCampaignId: "7ba53c91-6c8f-4b8a-b260-72eb48f62d07" },
      blockReason: null,
    });
    mocks.execute.mockResolvedValue({ rows: [{ id: contactPointId }] });
    mocks.runProcessingCronTick.mockResolvedValue({ jobsClaimed: 1, jobsCompleted: 1 });
    mocks.runVerificationCronTick.mockResolvedValue({ jobsClaimed: 1, emailsVerified: 1 });
    mocks.runAdminScopedDraftInstantlyImport.mockResolvedValue({
      status: "blocked",
      reason: "external_campaign_status_unverifiable",
    });
  });

  it("requires admin access before any campaign or job access", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    mocks.requireWorkspaceAdmin.mockRejectedValue(new UnauthorizedError());

    const response = await post({ action: "import", campaignId, contactPointId });

    expect(response.status).toBe(403);
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
  });

  it("processes only the requested candidate's normal job and bounds enrichment", async () => {
    mocks.getRawCandidateById.mockResolvedValue({ id: rawCandidateId, campaignId });
    mocks.enqueueAdminScopedProcessingJob.mockResolvedValue({ jobId: "job-1", status: "pending", created: true });

    const response = await post({
      action: "process",
      campaignId,
      rawCandidateId,
      executionId: "3d7e760b-4057-46f2-a534-499ad722f5ba",
    });

    expect(response.status).toBe(200);
    expect(mocks.enqueueAdminScopedProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      campaignId,
      rawCandidateId,
      executionId: "3d7e760b-4057-46f2-a534-499ad722f5ba",
    }));
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(1, expect.any(Date), expect.objectContaining({
      campaignId,
      jobId: "job-1",
      jobTypes: ["process_raw_candidate"],
      rawCandidateIds: [rawCandidateId],
      enrichContacts: true,
      requireQualifiedForContactEnrichment: true,
      allowMapsFastWebsiteRecovery: false,
      allowNicheWebsiteClassificationEvidence: false,
    }));
  });

  it("verifies only the requested contact point and never starts import", async () => {
    const response = await post({ action: "verify", campaignId, contactPointId });

    expect(response.status).toBe(200);
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(1, expect.objectContaining({
      campaignId,
      contactPointIds: [contactPointId],
      allowScopedDraftCampaign: true,
      skipInstantlyImport: true,
    }));
    await expect(response.json()).resolves.toMatchObject({ importAttempted: false });
  });

  it("fails closed on import when the scoped Draft preflight cannot verify external status", async () => {
    const response = await post({ action: "import", campaignId, contactPointId });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "external_campaign_status_unverifiable",
      importAttempted: false,
    });
    expect(mocks.runAdminScopedDraftInstantlyImport).toHaveBeenCalledWith({
      campaignId,
      workspaceId: "workspace-1",
      contactPointId,
    });
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
    expect(mocks.runVerificationCronTick).not.toHaveBeenCalled();
  });

  it("returns the bounded import result after the scoped preflight succeeds", async () => {
    mocks.runAdminScopedDraftInstantlyImport.mockResolvedValue({
      status: "complete",
      result: { leadsAttempted: 1, leadsAdded: 1 },
    });

    const response = await post({ action: "import", campaignId, contactPointId });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ importAttempted: true, leadsAdded: 1 });
    expect(mocks.runAdminScopedDraftInstantlyImport).toHaveBeenCalledWith({
      campaignId,
      workspaceId: "workspace-1",
      contactPointId,
    });
  });
});