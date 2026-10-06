import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  selectFrom: vi.fn(),
  selectWhere: vi.fn(),
  insert: vi.fn(),
  insertValues: vi.fn(),
  verifyWithCache: vi.fn(),
  enqueueVerificationJob: vi.fn(),
  upsertCampaignMembership: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  createProvider: vi.fn(),
  runInstantlyImportTick: vi.fn(),
  repairVerifiedAutopilotEmailMetadata: vi.fn(),
  evaluateComplianceForAccount: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ column, value })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { join: vi.fn((values: unknown[], separator: unknown) => ({ strings: ["", ""], values: [values, separator] })) },
  ),
}));
vi.mock("@/infrastructure/neon/db", () => ({
  getDb: () => ({
    execute: mocks.execute,
    update: mocks.update,
    select: mocks.select,
    insert: mocks.insert,
  }),
  schema: {
    verificationJobs: { id: "verification_jobs.id" },
    contactPoints: { id: "contact_points.id", accountId: "contact_points.account_id", normalizedValue: "contact_points.normalized_value" },
    emailVerificationEvents: {},
    emailVerifications: {},
  },
}));
vi.mock("@/infrastructure/providers/provider-factory", () => ({
  createEmailVerificationProvider: mocks.createProvider,
}));
vi.mock("@/services/verification/db-verification-cache", () => ({
  DbVerificationCacheStore: class {},
}));
vi.mock("@/services/verification/email-verification-cache", () => ({
  verifyEmailsWithCache: mocks.verifyWithCache,
}));
vi.mock("@/services/compliance/compliance-evaluator", () => ({
  repairVerifiedAutopilotEmailMetadata: mocks.repairVerifiedAutopilotEmailMetadata,
  evaluateComplianceForAccount: mocks.evaluateComplianceForAccount,
}));
vi.mock("@/lib/config/env", () => ({
  getDeliveryEnv: () => ({ INSTANTLY_CAMPAIGN_ID: "provider-campaign-1" }),
  getVerificationEnv: () => ({
    EMAIL_VERIFICATION_PROVIDER: "millionverifier",
    MILLION_VERIFIER: "configured",
    MILLIONVERIFIER_API_KEY: undefined,
  }),
}));
vi.mock("@/infrastructure/neon/repositories/verification-queue", () => ({
  enqueueVerificationJob: mocks.enqueueVerificationJob,
}));
vi.mock("@/infrastructure/neon/repositories/actual-outreach", () => ({
  actualPriorColdOutreachSql: vi.fn((scope: { workspaceId: string }) => ({ strings: [`TRUE ${scope.workspaceId}`], values: [] })),
}));
vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({
  upsertCampaignMembership: mocks.upsertCampaignMembership,
}));
vi.mock("@/infrastructure/jobs/runners/instantly-import-runner", () => ({
  runInstantlyImportTick: mocks.runInstantlyImportTick,
}));

import {
  enqueueVerificationJobs,
  getHistoricalBackfillProgress,
  repairProviderDisabledVerificationJobs,
  runVerificationCronTick,
} from "./verification-runner";

function sqlParts(value: unknown): { text: string; values: unknown[] } {
  if (!value || typeof value !== "object" || !("strings" in value) || !Array.isArray(value.strings)) {
    return { text: "", values: [] };
  }
  const query = value as { strings: string[]; values?: unknown[] };
  const nested = (query.values ?? []).map(sqlParts);
  return {
    text: query.strings.join(" ") + nested.map((part) => part.text).join(" "),
    values: (query.values ?? []).flatMap((item, index) => [item, ...nested[index]!.values]),
  };
}

describe("runVerificationCronTick eligibility recheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueVerificationJob.mockResolvedValue(true);
    mocks.execute
      .mockResolvedValueOnce({ rows: [{
        id: "verification-job-1",
        workspace_id: "workspace-1",
        contact_point_id: "contact-point-1",
        attempt_count: 1,
        max_attempts: 8,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "verification-job-1" }] });
    mocks.select.mockReturnValue({ from: mocks.selectFrom });
    mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
    mocks.selectWhere.mockResolvedValue([{
      id: "contact-point-1",
      accountId: "account-1",
      normalizedValue: "person@example.com",
    }]);
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.where.mockResolvedValue(undefined);
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.createProvider.mockReturnValue({ providerName: "millionverifier" });
    mocks.verifyWithCache.mockResolvedValue({
      outcomes: [{
        email: "person@example.com",
        code: "valid",
        providerRawCode: "ok",
        costUsd: 0.004,
        checkedAt: "2026-10-04T10:00:00.000Z",
        retryable: false,
      }],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 1, costUsd: 0.004, quotaRemaining: null },
    });
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

  it("runs a full historical backfill when no verification jobs are pending", async () => {
    mocks.execute.mockReset().mockResolvedValueOnce({ rows: [] });

    const result = await runVerificationCronTick(50, { backfillAll: true });

    expect(result.jobsClaimed).toBe(0);
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith(expect.objectContaining({
      backfillAll: true,
      now: expect.any(Date),
    }));
    expect(mocks.runInstantlyImportTick).not.toHaveBeenCalledWith(expect.objectContaining({ processQueueOnly: true }));
  });

  it("passes an old email through MillionVerifier and queues only a valid result for import", async () => {
    mocks.execute.mockReset()
      .mockResolvedValueOnce({ rows: [{
        id: "verification-job-1",
        workspace_id: "workspace-1",
        contact_point_id: "contact-point-1",
        attempt_count: 1,
        max_attempts: 8,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await runVerificationCronTick(50, { backfillAll: true });

    expect(mocks.createProvider).toHaveBeenCalledWith("workspace-1");
    expect(mocks.verifyWithCache).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: "millionverifier" }),
      ["person@example.com"],
      expect.any(Object),
      expect.any(Date),
    );
    expect(result.emailsVerified).toBe(1);
    expect(mocks.repairVerifiedAutopilotEmailMetadata).toHaveBeenCalledWith("workspace-1", "account-1");
    expect(mocks.runInstantlyImportTick).toHaveBeenCalledWith(expect.objectContaining({
      contactPointIds: ["contact-point-1"],
      backfillAll: true,
    }));
  });
});

describe("enqueueVerificationJobs scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueVerificationJob.mockResolvedValue(true);
  });

  it("queues unknown-channel email contacts for verification without a date cutoff", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.execute.mockResolvedValueOnce({ rows: [{
      contact_point_id: "selected-contact-point",
      workspace_id: "workspace-1",
      normalized_value: "person@example.com",
    }] });

    const queued = await enqueueVerificationJobs();
    const query = sqlParts(mocks.execute.mock.calls[2]?.[0]);

    expect(queued).toBe(1);
    expect(query.text).toContain("DISTINCT ON (ea.campaign_id, ea.account_id)");
    expect(query.text).toContain("SELECT DISTINCT cm.account_id, c.workspace_id");
    expect(query.text).toContain("TRUE c.workspace_id");
    expect(query.text).toContain("cp.channel_eligibility NOT IN ('opted_out', 'blocked')");
    expect(query.text).not.toContain("channel_eligibility IN (");
    expect(query.values).not.toEqual(expect.arrayContaining([
      "professional_contact",
      "eligible_email",
      "consented_email",
      "prior_relationship",
    ]));
    expect(query.text).not.toContain("cm.workspace_id");
    expect(query.text).not.toContain("cp.created_at >=");
    expect(mocks.enqueueVerificationJob).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactPointId: "selected-contact-point",
      normalizedEmail: "person@example.com",
      provider: "millionverifier",
    });
  });

  it("reactivates a provider-disabled unverified email with unknown channel eligibility", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{
      id: "verification-job-1",
      workspace_id: "workspace-1",
      contact_point_id: "contact-point-1",
      account_id: "account-1",
      verification_status: "unverified",
      verification_checked_at: null,
      cached_status: null,
      cache_checked_at: null,
      obsolete: false,
    }] });

    const result = await repairProviderDisabledVerificationJobs();
    const query = sqlParts(mocks.execute.mock.calls[0]?.[0]);

    expect(result).toMatchObject({ inspected: 1, reactivated: 1, suppressed: 0 });
    expect(query.text).toContain("cp.channel_eligibility IN ('opted_out', 'blocked')");
    expect(query.text).not.toContain("cp.channel_eligibility = 'unknown'");
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      provider: "millionverifier",
      status: "pending",
      lockedAt: null,
    }));
  });

  it("keeps explicitly opted-out provider-disabled contacts suppressed", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{
      id: "verification-job-2",
      workspace_id: "workspace-1",
      contact_point_id: "contact-point-2",
      account_id: "account-2",
      verification_status: "unverified",
      verification_checked_at: null,
      cached_status: null,
      cache_checked_at: null,
      obsolete: true,
    }] });

    const result = await repairProviderDisabledVerificationJobs();
    const query = sqlParts(mocks.execute.mock.calls[0]?.[0]);

    expect(result).toMatchObject({ inspected: 1, reactivated: 0, suppressed: 1 });
    expect(query.text).toContain("cp.channel_eligibility IN ('opted_out', 'blocked')");
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "suppressed",
      lastError: expect.stringContaining("no longer eligible"),
    }));
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("limits continuous verification discovery to the configured recent window", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const createdSince = new Date("2026-10-02T00:00:00.000Z");

    await enqueueVerificationJobs({ createdSince });
    const query = sqlParts(mocks.execute.mock.calls[2]?.[0]);

    expect(query.text).toContain("AND cp.created_at >=");
    expect(query.values).toContain(createdSince.toISOString());
  });

  it("adds qualified canonical historical accounts through existing compliance evaluation", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ workspace_id: "workspace-1", campaign_id: "campaign-1", account_id: "account-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await enqueueVerificationJobs();

    expect(mocks.upsertCampaignMembership).toHaveBeenCalledWith({
      campaignId: "campaign-1",
      accountId: "account-1",
      stage: "qualified",
    });
    expect(mocks.evaluateComplianceForAccount).toHaveBeenCalledWith("workspace-1", "account-1");
    const preparationQuery = sqlParts(mocks.execute.mock.calls[0]?.[0]);
    expect(preparationQuery.text).toContain("rc.processed = true");
    expect(preparationQuery.text).toContain("a.status IN ('qualified', 'contactable', 'outreach_ready')");
  });

  it("uses campaigns.workspace_id in historical progress queries", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{
      verification_candidates_remaining: 0,
      verification_jobs_pending: 0,
      eligible_valid_contacts_remaining: 0,
      instantly_import_jobs_pending: 0,
      instantly_deferred_due_to_plan_limit: 0,
    }] });

    await getHistoricalBackfillProgress();

    const query = sqlParts(mocks.execute.mock.calls[0]?.[0]);
    expect(query.text).toContain("se.workspace_id = c.workspace_id");
    expect(query.text).toContain("conv.workspace_id = c.workspace_id");
    expect(query.text).not.toContain("cm.workspace_id");
  });
});