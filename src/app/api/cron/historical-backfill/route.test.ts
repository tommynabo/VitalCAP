import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 })),
  runCronRoute: vi.fn(),
  repairProviderDisabledVerificationJobs: vi.fn(),
  enqueueVerificationJobs: vi.fn(),
  runVerificationCronTick: vi.fn(),
  getHistoricalBackfillProgress: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({
  repairProviderDisabledVerificationJobs: mocks.repairProviderDisabledVerificationJobs,
  enqueueVerificationJobs: mocks.enqueueVerificationJobs,
  runVerificationCronTick: mocks.runVerificationCronTick,
  getHistoricalBackfillProgress: mocks.getHistoricalBackfillProgress,
}));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: mocks.authorized,
  unauthorizedCronResponse: mocks.unauthorizedResponse,
  runCronRoute: mocks.runCronRoute,
}));

import { GET } from "./route";

function request(): Parameters<typeof GET>[0] {
  return { nextUrl: new URL("https://example.test/api/cron/historical-backfill") } as Parameters<typeof GET>[0];
}

describe("historical backfill cron route", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 without invoking backfill work when unauthorized", async () => {
    mocks.authorized.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.unauthorizedResponse).toHaveBeenCalledOnce();
    expect(mocks.runCronRoute).not.toHaveBeenCalled();
    expect(mocks.repairProviderDisabledVerificationJobs).not.toHaveBeenCalled();
  });

  it("runs exactly one bounded historical pass through the existing verification pipeline", async () => {
    mocks.authorized.mockReturnValue(true);
    mocks.runCronRoute.mockImplementation(async (_name, operation) => {
      mocks.order.push("cron");
        const result = await operation();
        return Response.json({ status: "completed", warnings: [], ...result.metadata, itemsProcessed: result.itemsProcessed });
    });
    mocks.repairProviderDisabledVerificationJobs.mockImplementation(async () => {
      mocks.order.push("repair");
      return { inspected: 3, resolvedFromCurrentResult: 1, reactivated: 1, suppressed: 0 };
    });
    mocks.enqueueVerificationJobs.mockImplementation(async () => {
      mocks.order.push("enqueue");
      return 40;
    });
    mocks.runVerificationCronTick.mockImplementation(async () => {
      mocks.order.push("tick");
      return {
        jobsClaimed: 25,
        emailsVerified: 24,
        verificationValid: 18,
        verificationInvalid: 3,
        verificationCatchAll: 1,
        verificationRisky: 2,
        millionVerifierStatus: "ready",
        instantly: { candidatesFound: 18, leadsQueued: 2, leadsAdded: 1 },
      };
    });
    mocks.getHistoricalBackfillProgress.mockImplementation(async () => {
      mocks.order.push("progress");
      return {
        verificationCandidatesRemaining: 100,
        verificationJobsPending: 20,
        verificationJobsProcessing: 2,
        verificationProviderDisabledJobs: 0,
        eligibleValidContactsRemaining: 10,
        instantlyImportJobsPending: 4,
        instantlyDeferredDueToPlanLimit: 0,
      };
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.order).toEqual(["cron", "repair", "enqueue", "tick", "progress"]);
    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith({});
    expect(mocks.runVerificationCronTick).toHaveBeenCalledOnce();
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { backfillAll: true });
    expect(mocks.getHistoricalBackfillProgress).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      itemsProcessed: 25,
      enqueued: 40,
      jobsClaimed: 25,
      emailsVerified: 24,
      verificationValid: 18,
      verificationInvalid: 3,
      verificationCatchAll: 1,
      verificationRisky: 2,
      instantly: { candidatesFound: 18, leadsQueued: 2, leadsAdded: 1 },
      remainingHistorical: 136,
    });
    expect(mocks.runVerificationCronTick.mock.calls[0]?.[1]).not.toHaveProperty("skipInstantlyImport");
  });
});