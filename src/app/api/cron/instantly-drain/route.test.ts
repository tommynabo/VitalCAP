import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 })),
  runCronRoute: vi.fn(),
  runInstantlyImportTick: vi.fn(),
}));

vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({
  runInstantlyImportTick: mocks.runInstantlyImportTick,
}));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: mocks.authorized,
  unauthorizedCronResponse: mocks.unauthorizedResponse,
  runCronRoute: mocks.runCronRoute,
}));

import { GET } from "./route";

function request(): Parameters<typeof GET>[0] {
  return { nextUrl: new URL("https://example.test/api/cron/instantly-drain") } as Parameters<typeof GET>[0];
}

describe("Instantly drain cron route", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 without running queue work when unauthorized", async () => {
    mocks.authorized.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.unauthorizedResponse).toHaveBeenCalledOnce();
    expect(mocks.runCronRoute).not.toHaveBeenCalled();
    expect(mocks.runInstantlyImportTick).not.toHaveBeenCalled();
  });

  it("runs only the queue-only Instantly tick when authorized", async () => {
    mocks.authorized.mockReturnValue(true);
    mocks.runInstantlyImportTick.mockResolvedValue({ leadsAttempted: 3 });
    mocks.runCronRoute.mockImplementation(async (_name, operation) => {
      const result = await operation();
      return Response.json({ status: "completed", ...result });
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledOnce();
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith({ processQueueOnly: true });
  });
});