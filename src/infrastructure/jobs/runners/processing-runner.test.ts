import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimProcessingJobs: vi.fn(),
  completeProcessingJob: vi.fn(),
  deferProcessingJob: vi.fn(),
  failProcessingJob: vi.fn(),
  enqueueProcessingJob: vi.fn(),
  getRawCandidateById: vi.fn(),
  refreshSearchSeedQualification: vi.fn(),
  getCampaignById: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  claimProcessingJobs: mocks.claimProcessingJobs,
  completeProcessingJob: mocks.completeProcessingJob,
  deferProcessingJob: mocks.deferProcessingJob,
  failProcessingJob: mocks.failProcessingJob,
  enqueueProcessingJob: mocks.enqueueProcessingJob,
}));

vi.mock("@/infrastructure/neon/repositories/discovery", () => ({
  getRawCandidateById: mocks.getRawCandidateById,
  refreshSearchSeedQualification: mocks.refreshSearchSeedQualification,
}));

vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({
  getCampaignById: mocks.getCampaignById,
}));

import { runProcessingCronTick } from "./processing-runner";

function makeJob(id: string) {
  return {
    id,
    campaignId: "campaign-id",
    type: "maps_deep_owner_enrichment",
    payload: { rawCandidateId: "raw-candidate-id" },
    status: "processing",
    attemptCount: 1,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: "worker",
    idempotencyKey: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(0);
  mocks.completeProcessingJob.mockResolvedValue(undefined);
  mocks.deferProcessingJob.mockResolvedValue(undefined);
  mocks.failProcessingJob.mockResolvedValue(undefined);
  mocks.getCampaignById.mockResolvedValue({ workspaceId: "workspace-id" });
  mocks.getRawCandidateById.mockResolvedValue({
    accountId: "account-id",
    rawPayload: { kind: "maps", place: { websiteUrl: null } },
    searchSeedRunId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runProcessingCronTick", () => {
  it("stops claiming before the time budget and leaves later work retryable", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([makeJob("job-1")])
      .mockResolvedValueOnce([makeJob("job-2")]);
    mocks.getRawCandidateById.mockImplementation(async () => {
      elapsed += 300;
      return {
        accountId: "account-id",
        rawPayload: { kind: "maps", place: { websiteUrl: null } },
        searchSeedRunId: null,
      };
    });

    const firstTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });

    expect(firstTick.jobsClaimed).toBe(1);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(1);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 1 }));
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
    expect(mocks.deferProcessingJob).not.toHaveBeenCalled();

    mocks.claimProcessingJobs.mockReset().mockResolvedValueOnce([makeJob("job-2")]).mockResolvedValueOnce([]);
    const secondTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });
    expect(secondTick.jobsClaimed).toBe(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(2);

    mocks.claimProcessingJobs.mockReset().mockResolvedValueOnce([]);
    const thirdTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });
    expect(thirdTick.jobsClaimed).toBe(0);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(2);
  });

  it("completes a normal batch serially", async () => {
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([makeJob("job-1")])
      .mockResolvedValueOnce([makeJob("job-2")])
      .mockResolvedValueOnce([]);

    const result = await runProcessingCronTick(3);

    expect(result.jobsClaimed).toBe(2);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(3);
    expect(mocks.completeProcessingJob.mock.calls.map(([input]) => input.jobId)).toEqual(["job-1", "job-2"]);
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("defers a claimed job if the budget expires before execution", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.claimProcessingJobs.mockImplementation(async () => {
      elapsed = 1000;
      return [makeJob("job-1")];
    });

    const result = await runProcessingCronTick(3, new Date("2026-01-01T00:00:00.000Z"), { timeBudgetMs: 1000 });

    expect(result.jobsClaimed).toBe(0);
    expect(mocks.deferProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    expect(mocks.completeProcessingJob).not.toHaveBeenCalled();
  });
});