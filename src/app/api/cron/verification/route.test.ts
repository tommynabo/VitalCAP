import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueVerificationJobs: vi.fn(),
  runVerificationCronTick: vi.fn(),
  getHistoricalBackfillProgress: vi.fn(),
}));

vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({
  enqueueVerificationJobs: mocks.enqueueVerificationJobs,
  runVerificationCronTick: mocks.runVerificationCronTick,
  getHistoricalBackfillProgress: mocks.getHistoricalBackfillProgress,
}));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: () => true,
  unauthorizedCronResponse: () => new Response(null, { status: 401 }),
  runCronRoute: async (_name: string, operation: () => Promise<unknown>) => {
    const result = await operation() as { itemsProcessed: number; metadata?: Record<string, unknown> };
    return Response.json({ status: "completed", itemsProcessed: result.itemsProcessed, warnings: [], ...result.metadata });
  },
}));

import { GET } from "./route";

const tickResult = {
  jobsClaimed: 0,
  emailsVerified: 0,
  millionVerifierStatus: "disabled",
  instantly: {
    candidatesFound: 0,
    leadsQueued: 0,
    leadsAdded: 0,
    leadsSkipped: 0,
    leadsDeferred: 0,
    leadsFailed: 0,
    providerStatus: "ready",
    quota: null,
    metrics: {},
  },
};

function request(search = ""): Parameters<typeof GET>[0] {
  return { nextUrl: new URL(`https://example.test/api/cron/verification${search}`) } as Parameters<typeof GET>[0];
}

describe("verification cron Instantly scan scope", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps scheduled verification and import work within the recent window", async () => {
    mocks.enqueueVerificationJobs.mockResolvedValue(0);
    mocks.runVerificationCronTick.mockResolvedValue(tickResult);

    await GET(request());

    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith({ createdSince: expect.any(Date) });
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { createdSince: expect.any(Date) });
  });

  it("uses bounded historical work only for explicit full backfill", async () => {
    mocks.enqueueVerificationJobs.mockResolvedValue(500);
    mocks.runVerificationCronTick.mockResolvedValue(tickResult);
    mocks.getHistoricalBackfillProgress.mockResolvedValue({
      verificationCandidatesRemaining: 11,
      verificationJobsPending: 7,
      eligibleValidContactsRemaining: 5,
      instantlyImportJobsPending: 2,
      instantlyDeferredDueToPlanLimit: 0,
    });

    const response = await GET(request("?backfill=all"));
    const body = await response.json() as Record<string, unknown>;

    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith({});
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { backfillAll: true });
    expect(body).toMatchObject({
      backfillMayContinue: true,
      remainingHistorical: 25,
      backfillProgress: {
        verificationCandidatesRemaining: 11,
        verificationJobsPending: 7,
        eligibleValidContactsRemaining: 5,
        instantlyImportJobsPending: 2,
      },
    });
  });

  it("keeps the explicit 48-hour import scope", async () => {
    mocks.enqueueVerificationJobs.mockResolvedValue(0);
    mocks.runVerificationCronTick.mockResolvedValue(tickResult);

    await GET(request("?backfill=48h"));

    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { createdSince: expect.any(Date) });
  });
});