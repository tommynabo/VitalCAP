import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPilotControlState: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/pilot-control", () => ({ getPilotControlState: mocks.getPilotControlState }));
vi.mock("@/infrastructure/neon/repositories/cron-runs", () => ({
  startCronRun: mocks.startCronRun,
  finishCronRun: mocks.finishCronRun,
}));
vi.mock("@/lib/observability/structured-logger", () => ({ logEvent: mocks.logEvent }));

import { isAuthorizedCronRequest, runCronRoute } from "./cron-http";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startCronRun.mockResolvedValue("cron-run-1");
  mocks.getPilotControlState.mockResolvedValue({ status: "disabled" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared cron pilot isolation", () => {
  it("does not run cron work while pilot control is active", async () => {
    mocks.getPilotControlState.mockResolvedValue({ status: "active" });
    const work = vi.fn();

    const response = await runCronRoute("test", work);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed_with_warnings", warnings: ["pilot_mode_active"] });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.finishCronRun).toHaveBeenCalledWith("cron-run-1", expect.objectContaining({ error: "pilot_mode_active" }));
  });

  it("fails closed when pilot state cannot be read", async () => {
    mocks.getPilotControlState.mockRejectedValue(new Error("control unavailable"));
    const work = vi.fn();

    const response = await runCronRoute("test", work);

    expect(response.status).toBe(500);
    expect(work).not.toHaveBeenCalled();
    expect(mocks.finishCronRun).toHaveBeenCalledWith("cron-run-1", expect.objectContaining({ status: "failed" }));
  });

  it.each(["disabled", "completed", "aborted"] as const)("keeps normal cron behavior when pilot is %s", async (status) => {
    mocks.getPilotControlState.mockResolvedValue({ status });
    const work = vi.fn().mockResolvedValue({ itemsProcessed: 2 });

    const response = await runCronRoute("test", work);

    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledOnce();
  });
});

describe("cron authorization in Vercel Preview", () => {
  it("rejects discovery execution before checking a configured cron secret", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");

    const request = new NextRequest("https://vitalcap.test/api/cron/discovery", {
      headers: { authorization: "Bearer test-cron-secret" },
    });

    expect(isAuthorizedCronRequest(request)).toBe(false);
  });
});