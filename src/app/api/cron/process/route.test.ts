import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorizedCronRequest: vi.fn(),
  unauthorizedCronResponse: vi.fn(),
  runCronRoute: vi.fn(),
  runProcessingCronTick: vi.fn(),
  getWatchdogWorkspaceSignals: vi.fn(),
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
vi.mock("@/infrastructure/neon/repositories/watchdog-signals", () => ({
  getWatchdogWorkspaceSignals: mocks.getWatchdogWorkspaceSignals,
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
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      oldDueDiscovery: 0,
      deferredDiscovery: 0,
      oldProcessing: 0,
      staleDiscoveryLocks: 0,
      staleProcessingLocks: 0,
      manualReconciliations: 0,
      processingPending: 0,
      processingCompletedRecent: 0,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 0,
    }]);
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
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(8, expect.any(Date), expect.objectContaining({ timeBudgetMs: 240_000, correlationId: expect.any(String) }));
  });

  it("raises processing capacity to the hard cap only for a large healthy draining queue", async () => {
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      oldDueDiscovery: 0,
      deferredDiscovery: 0,
      oldProcessing: 170,
      staleDiscoveryLocks: 0,
      staleProcessingLocks: 0,
      manualReconciliations: 0,
      processingPending: 170,
      processingCompletedRecent: 40,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 0,
    }]);

    const response = await GET({} as unknown as NextRequest);

    expect(response.status).toBe(200);
    expect(mocks.runProcessingCronTick).toHaveBeenCalledWith(16, expect.any(Date), expect.objectContaining({ timeBudgetMs: 240_000 }));
  });

  it("returns a generic failure when the processing work throws", async () => {
    mocks.runCronRoute.mockImplementation(async (_route: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch {
        return Response.json({ status: "failed", error: "sensitive database detail" }, { status: 500 });
      }
      return new Response(null, { status: 200 });
    });
    mocks.runProcessingCronTick.mockRejectedValue(new Error("sensitive database detail"));

    const response = await GET({} as unknown as NextRequest);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("sensitive database detail");
    expect(body).toContain('"status":"failed"');
  });

  it("does not run queue work for an unauthorized request", async () => {
    mocks.isAuthorizedCronRequest.mockReturnValue(false);

    const response = await GET({} as unknown as NextRequest);

    expect(response.status).toBe(401);
    expect(mocks.runCronRoute).not.toHaveBeenCalled();
    expect(mocks.runProcessingCronTick).not.toHaveBeenCalled();
  });
});