import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCacheForTests } from "@/lib/config/env";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  canEnqueueColdOutreach: vi.fn(),
  acquireLock: vi.fn(),
  claimImports: vi.fn(),
  deferByPlanLimit: vi.fn(),
  enqueueImport: vi.fn(),
  getImportCounts: vi.fn(),
  releaseLock: vi.fn(),
  updateImport: vi.fn(),
  getPlanUsage: vi.fn(),
  getMonthlyEmailUsage: vi.fn(),
  addLead: vi.fn(),
}));

vi.mock("@/infrastructure/neon/db", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("@/infrastructure/neon/repositories/outreach", () => ({
  canEnqueueColdOutreach: mocks.canEnqueueColdOutreach,
}));
vi.mock("@/infrastructure/neon/repositories/instantly-lead-imports", () => ({
  acquireInstantlyImportLock: mocks.acquireLock,
  claimInstantlyLeadImports: mocks.claimImports,
  deferInstantlyLeadImportsForPlanLimit: mocks.deferByPlanLimit,
  enqueueInstantlyLeadImport: mocks.enqueueImport,
  getInstantlyLeadImportCounts: mocks.getImportCounts,
  releaseInstantlyImportLock: mocks.releaseLock,
  updateInstantlyLeadImport: mocks.updateImport,
}));
vi.mock("@/infrastructure/providers/instantly/provider", () => ({
  InstantlyEmailDeliveryProvider: class {
    getPlanUsage = mocks.getPlanUsage;
    getMonthlyEmailUsage = mocks.getMonthlyEmailUsage;
    addLead = mocks.addLead;
  },
}));

import { runInstantlyImportTick } from "./instantly-import-runner";

const campaignId = "055534c5-c3e3-414f-b140-f4770b293c00";
const metricRow = { awaiting_verification: 3, verification_valid: 8, verification_blocked: 2 };
const readySchemaRows = [{ imports_ready: true, locks_ready: true }];

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "workspace-1",
    account_id: "account-1",
    source_campaign_id: "internal-campaign-1",
    contact_id: "contact-1",
    contact_point_id: "contact-point-1",
    normalized_email: "person@example.com",
    verification_status: "valid",
    channel_eligibility: "eligible_email",
    canonical_name: "Example Ltd",
    website_url: "https://example.com",
    normalized_domain: "example.com",
    city: "Madrid",
    country_code: "ES",
    first_name: "Alex",
    last_name: "Person",
    full_name: "Alex Person",
    ...overrides,
  };
}

function configureDbResults(rows: Array<Array<Record<string, unknown>>>): void {
  mocks.execute.mockReset();
  for (const resultRows of rows) mocks.execute.mockResolvedValueOnce({ rows: resultRows });
}

function metricReads(): Array<Record<string, unknown>> {
  return [metricRow];
}

function setupWithoutClaimedJobs(candidateRows: Array<Record<string, unknown>>): void {
  configureDbResults([readySchemaRows, metricReads(), candidateRows, metricReads(), metricReads()]);
  mocks.claimImports.mockResolvedValue([]);
  mocks.deferByPlanLimit.mockResolvedValue(0);
}

function setupWithOneClaimedJob(candidateRows: Array<Record<string, unknown>>, recheckRows = candidateRows): void {
  configureDbResults([readySchemaRows, metricReads(), candidateRows, metricReads(), recheckRows, metricReads()]);
  mocks.claimImports.mockResolvedValue([{
    id: "import-1",
    account_id: "account-1",
    contact_point_id: "contact-point-1",
    attempt_count: 1,
    max_attempts: 8,
  }]);
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("DEV_SEED_MODE", "false");
  vi.stubEnv("EMAIL_DELIVERY_PROVIDER", "instantly");
  vi.stubEnv("INSTANTLY_API_KEY", "test-key");
  vi.stubEnv("INSTANTLY_CAMPAIGN_ID", campaignId);
  vi.stubEnv("INSTANTLY_MAX_UPLOADED_CONTACTS", "1000");
  vi.stubEnv("INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD", "900");
  vi.stubEnv("INSTANTLY_MAX_MONTHLY_EMAILS", "5000");
  vi.stubEnv("INSTANTLY_MONTHLY_EMAIL_WARNING_THRESHOLD", "4500");
  resetServerEnvCacheForTests();
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [] });
  mocks.canEnqueueColdOutreach.mockResolvedValue(true);
  mocks.acquireLock.mockResolvedValue(true);
  mocks.enqueueImport.mockResolvedValue(true);
  mocks.getImportCounts.mockResolvedValue({});
  mocks.releaseLock.mockResolvedValue(undefined);
  mocks.updateImport.mockResolvedValue(undefined);
  mocks.getPlanUsage.mockResolvedValue({ currentLeadCount: 10, totalLeadLimit: 5000 });
  mocks.getMonthlyEmailUsage.mockResolvedValue({ emailsSent: 100 });
  mocks.addLead.mockResolvedValue({
    result: { providerLeadId: "provider-lead-1", status: "added" },
    usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 1, costUsd: 0, quotaRemaining: 999 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("runInstantlyImportTick", () => {
  it("does not start import work until both migration tables exist", async () => {
    configureDbResults([[{ imports_ready: false, locks_ready: false }]]);

    const result = await runInstantlyImportTick({ backfillAll: true });

    expect(result.providerStatus).toBe("schema_not_ready");
    expect(result.candidatesFound).toBe(0);
    expect(mocks.getPlanUsage).not.toHaveBeenCalled();
    expect(mocks.claimImports).not.toHaveBeenCalled();
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("queues eligible leads without sending when Instantly delivery is disabled", async () => {
    vi.stubEnv("EMAIL_DELIVERY_PROVIDER", "disabled");
    resetServerEnvCacheForTests();
    setupWithoutClaimedJobs([candidate()]);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsQueued).toBe(1);
    expect(result.providerStatus).toBe("missing_configuration");
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("imports an eligible verified lead and persists the provider result", async () => {
    setupWithOneClaimedJob([candidate()]);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsAdded).toBe(1);
    expect(mocks.addLead).toHaveBeenCalledWith(expect.objectContaining({
      providerCampaignId: campaignId,
      email: "person@example.com",
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
      customVariables: expect.objectContaining({
        first_name: "Alex",
        last_name: "Person",
        company_name: "Example Ltd",
        website: "https://example.com",
        city: "Madrid",
        country: "ES",
      }),
    }));
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({
      status: "instantly_added",
      providerLeadId: "provider-lead-1",
    }));
  });

  it.each(["invalid", "catch_all", "risky", "unknown", "disposable"])(
    "never imports a %s email",
    async (verificationStatus) => {
      setupWithoutClaimedJobs([candidate({ verification_status: verificationStatus })]);

      const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

      expect(result.leadsQueued).toBe(0);
      expect(mocks.enqueueImport).not.toHaveBeenCalled();
      expect(mocks.addLead).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue accounts blocked by the shared cold-outreach deduplicator", async () => {
    setupWithoutClaimedJobs([candidate()]);
    mocks.canEnqueueColdOutreach.mockResolvedValue(false);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsQueued).toBe(0);
    expect(mocks.enqueueImport).not.toHaveBeenCalled();
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("lets the database account identity admit only one contact from a duplicate account", async () => {
    const first = candidate();
    const second = candidate({ contact_point_id: "contact-point-2", normalized_email: "other@example.com" });
    setupWithOneClaimedJob([first, second], [first]);
    mocks.enqueueImport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await runInstantlyImportTick({ createdSince: new Date("2026-10-02T00:00:00.000Z") });

    expect(result.leadsQueued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledTimes(2);
    expect(mocks.addLead).toHaveBeenCalledOnce();
  });

  it("persists provider failures as retryable imports", async () => {
    setupWithOneClaimedJob([candidate()]);
    mocks.addLead.mockRejectedValue(new Error("Instantly API error: 503"));

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsFailed).toBe(1);
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({
      status: "failed",
      lastError: "Instantly API error: 503",
      nextAttemptAt: expect.any(Date),
    }));
  });

  it("stops at contact and monthly plan limits before claiming jobs", async () => {
    setupWithoutClaimedJobs([candidate()]);
    mocks.getPlanUsage.mockResolvedValue({ currentLeadCount: 1000, totalLeadLimit: 5000 });
    mocks.getMonthlyEmailUsage.mockResolvedValue({ emailsSent: 5000 });
    mocks.deferByPlanLimit.mockResolvedValue(1);

    const result = await runInstantlyImportTick({ createdSince: new Date("2026-10-02T00:00:00.000Z") });

    expect(result.quota).toMatchObject({
      uploadedContacts: 1000,
      hardLimit: 1000,
      monthlyEmailsSent: 5000,
      monthlyEmailLimit: 5000,
    });
    expect(result.leadsDeferred).toBe(1);
    expect(mocks.deferByPlanLimit).toHaveBeenCalledWith(campaignId, expect.any(Date));
    expect(mocks.claimImports).not.toHaveBeenCalled();
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("limits claims to remaining contact slots near the hard limit", async () => {
    setupWithoutClaimedJobs([candidate()]);
    mocks.getPlanUsage.mockResolvedValue({ currentLeadCount: 999, totalLeadLimit: 5000 });

    await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(mocks.claimImports).toHaveBeenCalledWith(1, expect.any(Date));
  });

  it("can rerun the same 48-hour backfill without creating a second import", async () => {
    configureDbResults([
      readySchemaRows, metricReads(), [candidate()], metricReads(), metricReads(),
      readySchemaRows, metricReads(), [candidate()], metricReads(), metricReads(),
    ]);
    mocks.claimImports.mockResolvedValue([]);
    mocks.enqueueImport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const createdSince = new Date("2026-10-02T00:00:00.000Z");

    await runInstantlyImportTick({ createdSince });
    await runInstantlyImportTick({ createdSince });

    expect(mocks.enqueueImport).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueImport).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactPointId: "contact-point-1",
      providerCampaignId: campaignId,
    }));
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("imports a historical valid contact in full-backfill mode", async () => {
    setupWithOneClaimedJob([candidate({ created_at: "2024-01-01T00:00:00.000Z" })]);

    const result = await runInstantlyImportTick({ backfillAll: true });

    expect(result.candidatesFound).toBe(1);
    expect(result.leadsAdded).toBe(1);
    expect(mocks.addLead).toHaveBeenCalledOnce();
  });

  it("continues the full historical scan in a second bounded batch", async () => {
    const firstBatch = Array.from({ length: 500 }, (_, index) => candidate({
      account_id: `account-${index}`,
      contact_id: `contact-${index}`,
      contact_point_id: `contact-point-${index}`,
      normalized_email: `person-${index}@example.com`,
    }));
    const secondBatch = [candidate({
      account_id: "account-500",
      contact_id: "contact-500",
      contact_point_id: "contact-point-500",
      normalized_email: "person-500@example.com",
    })];
    configureDbResults([
      readySchemaRows, metricReads(), firstBatch, metricReads(), metricReads(),
      readySchemaRows, metricReads(), secondBatch, metricReads(), metricReads(),
    ]);
    mocks.claimImports.mockResolvedValue([]);

    const first = await runInstantlyImportTick({ backfillAll: true });
    const second = await runInstantlyImportTick({ backfillAll: true });

    expect(first.candidatesFound).toBe(500);
    expect(first.leadsQueued).toBe(500);
    expect(second.candidatesFound).toBe(1);
    expect(second.leadsQueued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledTimes(501);
  });
});