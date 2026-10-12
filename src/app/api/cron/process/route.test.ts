import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorizedCronRequest: vi.fn(),
  unauthorizedCronResponse: vi.fn(),
  runCronRoute: vi.fn(),
  runProcessingCronTick: vi.fn(),
}));

vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: mocks.isAuthorizedCronRequest,
  unauthorizedCronResponse: mocks.unauthorizedCronResponse,
  runCronRoute: mocks.runCronRoute,
}));

vi.mock("@/infrastructure/jobs/runners/processing-runner", () => ({
  PROCESSING_CRON_TIME_BUDGET_MS: 240_000,
  PROCESSING_MAX_JOBS_PER_TICK: 8,
  runProcessingCronTick: mocks.runProcessingCronTick,
}));

import type { NextRequest } from "next/server";
import { GET } from "./route";

describe("processing cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorizedCronRequest.mockReturnValue(true);
    mocks.unauthorizedCronResponse.mockReturnValue(new Response(null, { status: 401 }));
    mocks.runProcessingCronTick.mockResolvedValue({
      jobsClaimed: 8,
      jobsCompleted: 8,
      jobsTimedOut: 0,
      cleanupFailures: 0,
      durationMs: 100_000,
    });
    mocks.runCronRoute.mockImplementation(async (_route: string, work: () => Promise<unknown>) => {
      await work();
      return new Response(null, { status: 200 });
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the configured bounded capacity through canonical cron plumbing", async () => {
    const response = await GET({} as unknown as NextRequest);

    expect(response.status).toBe(200);
    expect(mocks.runCronRoute).toHaveBeenCalledWith("process", expect.any(Function));
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(8, expect.any(Date), { timeBudgetMs: 240_000 });
  });

  it("does not run queue work for an unauthorized request", async () => {
    mocks.isAuthorizedCronRequest.mockReturnValue(false);

    const response = await GET({} as unknown as NextRequest);

    expect(response.status).toBe(401);
    expect(mocks.runCronRoute).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
  });
});