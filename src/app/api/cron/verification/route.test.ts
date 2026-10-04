import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueVerificationJobs: vi.fn(),
  runVerificationCronTick: vi.fn(),
}));

vi.mock("@/infrastructure/jobs/runners/verification-runner", () => ({
  enqueueVerificationJobs: mocks.enqueueVerificationJobs,
  runVerificationCronTick: mocks.runVerificationCronTick,
}));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: () => true,
  unauthorizedCronResponse: () => new Response(null, { status: 401 }),
  runCronRoute: (_name: string, operation: () => Promise<unknown>) => operation(),
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

  it("scans all eligible historical leads by default without historical verification enqueue", async () => {
    mocks.enqueueVerificationJobs.mockResolvedValue(0);
    mocks.runVerificationCronTick.mockResolvedValue(tickResult);

    await GET(request());

    expect(mocks.enqueueVerificationJobs).toHaveBeenCalledWith({ createdSince: expect.any(Date) });
    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { backfillAll: true });
  });

  it("keeps the explicit 48-hour import scope", async () => {
    mocks.enqueueVerificationJobs.mockResolvedValue(0);
    mocks.runVerificationCronTick.mockResolvedValue(tickResult);

    await GET(request("?backfill=48h"));

    expect(mocks.runVerificationCronTick).toHaveBeenCalledWith(50, { createdSince: expect.any(Date) });
  });
});