import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  createProvider: vi.fn(),
  runInstantlyImportTick: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ column, value })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@/infrastructure/neon/db", () => ({
  getDb: () => ({ execute: mocks.execute, update: mocks.update }),
  schema: { verificationJobs: { id: "verification_jobs.id" } },
}));
vi.mock("@/infrastructure/providers/provider-factory", () => ({
  createEmailVerificationProvider: mocks.createProvider,
}));
vi.mock("@/services/verification/db-verification-cache", () => ({
  DbVerificationCacheStore: class {},
}));
vi.mock("@/services/verification/email-verification-cache", () => ({
  verifyEmailsWithCache: vi.fn(),
}));
vi.mock("@/lib/config/env", () => ({
  getVerificationEnv: () => ({
    EMAIL_VERIFICATION_PROVIDER: "millionverifier",
    MILLION_VERIFIER: "configured",
    MILLIONVERIFIER_API_KEY: undefined,
  }),
}));
vi.mock("@/infrastructure/neon/repositories/verification-queue", () => ({
  enqueueVerificationJob: vi.fn(),
}));
vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({
  runInstantlyImportTick: mocks.runInstantlyImportTick,
}));

import { runVerificationCronTick } from "./verification-runner";

describe("runVerificationCronTick eligibility recheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "verification-job-1",
        workspace_id: "workspace-1",
        contact_point_id: "contact-point-1",
        attempt_count: 1,
        max_attempts: 8,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "verification-job-1" }] });
    mocks.where.mockResolvedValue(undefined);
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.runInstantlyImportTick.mockResolvedValue({
      candidatesFound: 0,
      leadsQueued: 0,
      leadsAdded: 0,
      leadsSkipped: 0,
      leadsDeferred: 0,
      leadsFailed: 0,
      providerStatus: "ready",
      quota: null,
      metrics: {},
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("suppresses a previously claimed job before creating or calling the provider", async () => {
    const result = await runVerificationCronTick();

    expect(result.jobsClaimed).toBe(1);
    expect(result.emailsVerified).toBe(0);
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: null,
    }));
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith(expect.objectContaining({ processQueueOnly: true }));
  });

  it("runs the requested backfill when there are no verification jobs", async () => {
    mocks.execute.mockReset().mockResolvedValueOnce({ rows: [] });
    const createdSince = new Date("2026-10-02T00:00:00.000Z");

    const result = await runVerificationCronTick(50, { createdSince });

    expect(result.jobsClaimed).toBe(0);
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith(expect.objectContaining({
      createdSince,
      now: expect.any(Date),
    }));
    expect(mocks.runInstantlyImportTick).not.toHaveBeenCalledWith(expect.objectContaining({ processQueueOnly: true }));
  });
});