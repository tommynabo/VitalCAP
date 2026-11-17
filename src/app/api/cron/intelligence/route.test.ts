import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  processBatch: vi.fn(),
  getPilotControlState: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/services/intelligence/queue-processor", () => ({
  IntelligenceQueueProcessor: class {
    processBatch() {
      return mocks.processBatch();
    }
  },
}));
vi.mock("@/infrastructure/neon/repositories/pilot-control", () => ({ getPilotControlState: mocks.getPilotControlState }));
vi.mock("@/infrastructure/neon/repositories/cron-runs", () => ({
  startCronRun: mocks.startCronRun,
  finishCronRun: mocks.finishCronRun,
}));
vi.mock("@/lib/observability/structured-logger", () => ({ logEvent: mocks.logEvent }));
vi.mock("../_lib/cron-http", async (importOriginal) => ({
  ...await importOriginal<typeof import("../_lib/cron-http")>(),
  isAuthorizedCronRequest: mocks.authorized,
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://vitalcap.test/api/cron/intelligence");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.authorized.mockReturnValue(true);
  mocks.getPilotControlState.mockResolvedValue({ status: "disabled" });
  mocks.startCronRun.mockResolvedValue("cron-run-1");
  mocks.processBatch.mockResolvedValue({ claimed: 2, completed: 1, deferred: 0, failed: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/intelligence pilot isolation", () => {
  it("returns 401 without authorization before creating a cron run", async () => {
    mocks.authorized.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.startCronRun).not.toHaveBeenCalled();
    expect(mocks.processBatch).not.toHaveBeenCalled();
  });

  it("rejects Preview before processing Intelligence jobs", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    mocks.authorized.mockImplementation(() => process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "preview");

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.startCronRun).not.toHaveBeenCalled();
    expect(mocks.processBatch).not.toHaveBeenCalled();
  });

  it("does not claim jobs, invoke the processor, or update accounts during an active pilot", async () => {
    mocks.getPilotControlState.mockResolvedValue({ status: "active" });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, processed: 0, claimed: 0, status: "pilot_mode_active" });
    expect(mocks.processBatch).not.toHaveBeenCalled();
    expect(mocks.finishCronRun).toHaveBeenCalledOnce();
    expect(mocks.startCronRun).toHaveBeenCalledOnce();
  });

  it("fails closed on pilot-state read errors", async () => {
    mocks.getPilotControlState.mockRejectedValue(new Error("control read failed"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
    expect(mocks.processBatch).not.toHaveBeenCalled();
    expect(mocks.finishCronRun).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "completed", "aborted"] as const)("preserves normal processing when pilot is %s", async (status) => {
    mocks.getPilotControlState.mockResolvedValue({ status });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, processed: 1, claimed: 2, deferred: 0, failed: 1 });
    expect(mocks.processBatch).toHaveBeenCalledOnce();
    expect(mocks.startCronRun).toHaveBeenCalledOnce();
  });
});