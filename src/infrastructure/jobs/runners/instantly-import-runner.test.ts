import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCacheForTests } from "@/lib/config/env";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  hasActualPriorColdOutreach: vi.fn(),
  acquireLock: vi.fn(),
  claimImports: vi.fn(),
  deferByPlanLimit: vi.fn(),
  enqueueImport: vi.fn(),
  getImportCounts: vi.fn(),
  isCircuitOpen: vi.fn(),
  releaseLock: vi.fn(),
  tripCircuitBreaker: vi.fn(),
  updateImport: vi.fn(),
  getPlanUsage: vi.fn(),
  getMonthlyEmailUsage: vi.fn(),
  addLeads: vi.fn(),
  addLeadToCampaign: vi.fn(),
  findLeadInCampaign: vi.fn(),
}));

vi.mock("@/infrastructure/neon/db", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("@/infrastructure/neon/repositories/actual-outreach", () => ({
  actualPriorColdOutreachSql: vi.fn(() => ({ strings: ["TRUE"], values: [] })),
  hasActualPriorColdOutreach: mocks.hasActualPriorColdOutreach,
}));
vi.mock("@/infrastructure/neon/repositories/instantly-lead-imports", () => ({
  acquireInstantlyImportLock: mocks.acquireLock,
  claimInstantlyLeadImports: mocks.claimImports,
  deferInstantlyLeadImportsForPlanLimit: mocks.deferByPlanLimit,
  enqueueInstantlyLeadImport: mocks.enqueueImport,
  getInstantlyLeadImportCounts: mocks.getImportCounts,
  isInstantlyImportCircuitOpen: mocks.isCircuitOpen,
  releaseInstantlyImportLock: mocks.releaseLock,
  tripInstantlyImportCircuitBreaker: mocks.tripCircuitBreaker,
  updateInstantlyLeadImport: mocks.updateImport,
}));
vi.mock("@/infrastructure/providers/instantly/provider", () => ({
  InstantlyEmailDeliveryProvider: class {
    getPlanUsage = mocks.getPlanUsage;
    getMonthlyEmailUsage = mocks.getMonthlyEmailUsage;
    addLeads = mocks.addLeads;
    addLeadToCampaign = mocks.addLeadToCampaign;
    findLeadInCampaign = mocks.findLeadInCampaign;
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

function setupWithClaimedJobs(
  candidateRows: Array<Record<string, unknown>>,
  jobs: Array<Record<string, unknown>>,
  recheckRows = candidateRows,
): void {
  configureDbResults([readySchemaRows, metricReads(), candidateRows, metricReads(), recheckRows, metricReads()]);
  mocks.claimImports.mockResolvedValue(jobs);
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
  mocks.hasActualPriorColdOutreach.mockResolvedValue(false);
  mocks.acquireLock.mockResolvedValue(true);
  mocks.enqueueImport.mockResolvedValue(true);
  mocks.getImportCounts.mockResolvedValue({});
  mocks.releaseLock.mockResolvedValue(undefined);
  mocks.isCircuitOpen.mockResolvedValue(false);
  mocks.tripCircuitBreaker.mockResolvedValue(undefined);
  mocks.updateImport.mockResolvedValue(undefined);
  mocks.getPlanUsage.mockResolvedValue({ currentLeadCount: 10, totalLeadLimit: 5000 });
  mocks.getMonthlyEmailUsage.mockResolvedValue({ emailsSent: 100 });
  mocks.addLeads.mockResolvedValue({
    outcomes: [{ index: 0, providerLeadId: "provider-lead-1", status: "added", diagnostic: null }],
    usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 1, costUsd: 0, quotaRemaining: 999 },
  });
  mocks.addLeadToCampaign.mockResolvedValue({
    status: "added",
    providerLeadId: "provider-lead-1",
    httpStatus: 200,
    requestId: "request-1",
    sanitizedProviderMessage: null,
  });
  mocks.findLeadInCampaign.mockResolvedValue("provider-lead-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
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
    expect(mocks.addLeads).not.toHaveBeenCalled();
  });

  it("queues eligible leads without sending when Instantly delivery is disabled", async () => {
    vi.stubEnv("EMAIL_DELIVERY_PROVIDER", "disabled");
    resetServerEnvCacheForTests();
    setupWithoutClaimedJobs([candidate()]);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsQueued).toBe(1);
    expect(result.providerStatus).toBe("missing_configuration");
    expect(mocks.addLeads).not.toHaveBeenCalled();
  });

  it("imports an eligible verified lead and persists the provider result", async () => {
    setupWithOneClaimedJob([candidate()]);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
    expect(mocks.findLeadInCampaign).toHaveBeenCalledWith(campaignId, "person@example.com");
    expect(result.leadsAdded).toBe(1);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledWith(expect.objectContaining({
      providerCampaignId: campaignId,
      email: "person@example.com",
      skipIfInWorkspace: false,
      skipIfInCampaign: true,
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

  it("uses direct single-lead writes with exact flags and readback for every claimed job", async () => {
    const candidates = [
      candidate(),
      candidate({
        account_id: "account-2",
        contact_point_id: "contact-point-2",
        normalized_email: "second@example.com",
      }),
    ];
    setupWithClaimedJobs(candidates, [
      { id: "import-1", account_id: "account-1", contact_point_id: "contact-point-1", attempt_count: 1, max_attempts: 8 },
      { id: "import-2", account_id: "account-2", contact_point_id: "contact-point-2", attempt_count: 1, max_attempts: 8 },
    ]);

    const result = await runInstantlyImportTick({
      contactPointIds: candidates.map((row) => String(row.contact_point_id)),
      maxJobs: 2,
    });

    expect(result.leadsAttempted).toBe(2);
    expect(result.leadsAdded).toBe(2);
    expect(mocks.claimImports).toHaveBeenCalledWith(2, expect.any(Date));
    expect(mocks.addLeads).not.toHaveBeenCalled();
    expect(mocks.addLeadToCampaign).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.addLeadToCampaign.mock.calls) {
      expect(input).toEqual(expect.objectContaining({
        providerCampaignId: campaignId,
        skipIfInWorkspace: false,
        skipIfInCampaign: true,
      }));
    }
    expect(mocks.findLeadInCampaign).toHaveBeenCalledTimes(2);
    expect(mocks.findLeadInCampaign).toHaveBeenCalledWith(campaignId, "person@example.com");
    expect(mocks.findLeadInCampaign).toHaveBeenCalledWith(campaignId, "second@example.com");
  });

  it("limits simultaneous direct Instantly writes to two", async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({
      account_id: `account-${index}`,
      contact_point_id: `contact-point-${index}`,
      normalized_email: `person-${index}@example.com`,
    }));
    const jobs = candidates.map((row, index) => ({
      id: `import-${index}`,
      account_id: row.account_id,
      contact_point_id: row.contact_point_id,
      attempt_count: 1,
      max_attempts: 8,
    }));
    setupWithClaimedJobs(candidates, jobs);
    let activeWrites = 0;
    let maxActiveWrites = 0;
    mocks.addLeadToCampaign.mockImplementation(async () => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await Promise.resolve();
      activeWrites--;
      return {
        status: "added",
        providerLeadId: "provider-lead",
        httpStatus: 200,
        requestId: "request-1",
        sanitizedProviderMessage: null,
      };
    });

    await runInstantlyImportTick({
      contactPointIds: candidates.map((row) => String(row.contact_point_id)),
      maxJobs: 4,
    });

    expect(maxActiveWrites).toBe(2);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledTimes(4);
    expect(mocks.addLeads).not.toHaveBeenCalled();
  });

  it.each([401, 403])("stops scheduling after a direct-write authorization failure (%i)", async (httpStatus) => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({
      account_id: `account-${index}`,
      contact_point_id: `contact-point-${index}`,
      normalized_email: `person-${index}@example.com`,
    }));
    const jobs = candidates.map((row, index) => ({
      id: `import-${index}`,
      account_id: row.account_id,
      contact_point_id: row.contact_point_id,
      attempt_count: 1,
      max_attempts: 8,
    }));
    setupWithClaimedJobs(candidates, jobs);
    let releaseSecondWrite: ((result: {
      status: "failed";
      providerLeadId: null;
      httpStatus: number;
      requestId: string;
      sanitizedProviderMessage: string;
    }) => void) | undefined;
    let writeCount = 0;
    mocks.addLeadToCampaign.mockImplementation(() => {
      writeCount++;
      if (writeCount === 1) {
        return Promise.resolve({
          status: "failed",
          providerLeadId: null,
          httpStatus,
          requestId: "auth-request",
          sanitizedProviderMessage: "Unauthorized",
        });
      }
      if (writeCount === 2) {
        return new Promise((resolve) => { releaseSecondWrite = resolve; });
      }
      return Promise.resolve({
        status: "added",
        providerLeadId: "unexpected-lead",
        httpStatus: 200,
        requestId: "unexpected-request",
        sanitizedProviderMessage: null,
      });
    });

    const pending = runInstantlyImportTick({
      contactPointIds: candidates.map((row) => String(row.contact_point_id)),
      maxJobs: 4,
    });
    await vi.waitFor(() => expect(mocks.tripCircuitBreaker).toHaveBeenCalledOnce());
    releaseSecondWrite?.({
      status: "failed",
      providerLeadId: null,
      httpStatus: 503,
      requestId: "temporary-request",
      sanitizedProviderMessage: "Unavailable",
    });
    const result = await pending;

    expect(result.providerStatus).toBe("unhealthy");
    expect(result.instantlyLeadImportReady).toBe(false);
    expect(result.leadsAttempted).toBe(2);
    expect(result.leadsDeferred).toBe(2);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledTimes(2);
    expect(mocks.addLeads).not.toHaveBeenCalled();
    expect(mocks.tripCircuitBreaker).toHaveBeenCalledWith(campaignId, expect.any(String), "auth-request");
    expect(mocks.updateImport).toHaveBeenCalledWith("import-2", expect.objectContaining({
      status: "deferred",
      decrementAttemptCount: true,
    }));
  });

  it("retries failed membership readback without posting the lead again", async () => {
    vi.useFakeTimers();
    setupWithOneClaimedJob([candidate()]);
    mocks.findLeadInCampaign.mockResolvedValue(null);

    const pending = runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.leadsAttempted).toBe(1);
    expect(result.leadsNeedsReconciliation).toBe(1);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
    expect(mocks.addLeads).not.toHaveBeenCalled();
    expect(mocks.findLeadInCampaign).toHaveBeenCalledTimes(4);
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({
      status: "reconciliation_required",
    }));
  });

  it("records an Instantly import without marking actual cold outreach", async () => {
    setupWithOneClaimedJob([candidate()]);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsAdded).toBe(1);
    expect(mocks.updateImport).toHaveBeenCalledTimes(1);
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({ status: "instantly_added" }));
    expect(mocks.hasActualPriorColdOutreach).toHaveBeenCalledOnce();
  });

  it.each(["invalid", "catch_all", "risky", "unknown", "disposable"])(
    "never imports a %s email",
    async (verificationStatus) => {
      setupWithoutClaimedJobs([candidate({ verification_status: verificationStatus })]);

      const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

      expect(result.leadsQueued).toBe(0);
      expect(mocks.enqueueImport).not.toHaveBeenCalled();
      expect(mocks.addLeads).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue accounts blocked by the shared cold-outreach deduplicator", async () => {
    setupWithoutClaimedJobs([candidate()]);
    mocks.hasActualPriorColdOutreach.mockResolvedValue(true);

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsQueued).toBe(0);
    expect(mocks.enqueueImport).not.toHaveBeenCalled();
    expect(mocks.addLeads).not.toHaveBeenCalled();
    expect(mocks.addLeadToCampaign).not.toHaveBeenCalled();
  });

  it("lets the database account identity admit only one contact from a duplicate account", async () => {
    const first = candidate();
    const second = candidate({ contact_point_id: "contact-point-2", normalized_email: "other@example.com" });
    setupWithOneClaimedJob([first, second], [first]);
    mocks.enqueueImport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await runInstantlyImportTick({ createdSince: new Date("2026-10-02T00:00:00.000Z") });

    expect(result.leadsQueued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledTimes(2);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
  });

  it("persists provider failures as retryable imports", async () => {
    setupWithOneClaimedJob([candidate()]);
    mocks.addLeadToCampaign.mockResolvedValue({
      status: "failed",
      providerLeadId: null,
      httpStatus: 503,
      requestId: "request-503",
      sanitizedProviderMessage: "Temporarily unavailable",
    });

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsFailed).toBe(1);
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({
      status: "failed",
      lastError: "Temporarily unavailable",
      nextAttemptAt: expect.any(Date),
    }));
  });

  it.each(["billing", "analytics"])("imports despite an unavailable %s telemetry endpoint", async (unavailableTelemetry) => {
    if (unavailableTelemetry === "billing") {
      setupWithOneClaimedJob([candidate()]);
      mocks.getPlanUsage.mockRejectedValue(new Error("billing scope missing"));
    } else {
      configureDbResults([
        readySchemaRows,
        metricReads(),
        [candidate()],
        metricReads(),
        [{ count: 100 }],
        [candidate()],
        metricReads(),
      ]);
      mocks.claimImports.mockResolvedValue([{
        id: "import-1",
        account_id: "account-1",
        contact_point_id: "contact-point-1",
        attempt_count: 1,
        max_attempts: 8,
      }]);
    }
    if (unavailableTelemetry === "analytics") {
      mocks.getMonthlyEmailUsage.mockRejectedValue(new Error("analytics scope missing"));
    }

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.leadsAdded).toBe(1);
    expect(result.instantlyTelemetryReady).toBe(false);
    expect(result.telemetryWarnings).toContain(
      unavailableTelemetry === "billing" ? "workspace-billing/plan-details unavailable" : "campaigns/analytics unavailable",
    );
    expect(result.instantlyLeadImportReady).toBe(true);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("opens a durable circuit on leads/add %i and blocks later ticks", async (httpStatus) => {
    setupWithOneClaimedJob([candidate()]);
    const unauthorized = new Error(`Instantly API request failed: endpoint=leads/add http_status=${httpStatus} provider_code=Unauthorized message=Invalid key request_id=req-123`);
    unauthorized.name = "InstantlyApiError";
    Object.assign(unauthorized, { details: { endpointCategory: "leads/add", httpStatus, requestId: "req-123" } });
    mocks.addLeadToCampaign.mockResolvedValue({
      status: "failed",
      providerLeadId: null,
      httpStatus,
      requestId: "req-123",
      sanitizedProviderMessage: "Invalid key",
    });

    const result = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(result.providerStatus).toBe("unhealthy");
    expect(result.instantlyLeadImportReady).toBe(false);
    expect(result.leadsFailed).toBe(1);
    expect(mocks.updateImport).toHaveBeenCalledWith("import-1", expect.objectContaining({
      status: "failed",
      lastError: "Invalid key",
    }));
    expect(mocks.tripCircuitBreaker).toHaveBeenCalledWith(campaignId, expect.any(String), "req-123");
    expect(mocks.releaseLock).not.toHaveBeenCalled();
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();

    configureDbResults([readySchemaRows, metricReads(), [candidate()], metricReads(), metricReads()]);
    mocks.acquireLock.mockResolvedValue(false);
    mocks.isCircuitOpen.mockResolvedValue(true);
    const nextTick = await runInstantlyImportTick({ contactPointIds: ["contact-point-1"] });

    expect(nextTick.providerStatus).toBe("unhealthy");
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
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
    expect(mocks.addLeads).not.toHaveBeenCalled();
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
    expect(mocks.addLeads).not.toHaveBeenCalled();
  });

  it("imports a historical valid contact in full-backfill mode", async () => {
    setupWithOneClaimedJob([candidate({ created_at: "2024-01-01T00:00:00.000Z" })]);

    const result = await runInstantlyImportTick({ backfillAll: true });

    expect(result.candidatesFound).toBe(1);
    expect(result.leadsAdded).toBe(1);
    expect(mocks.addLeadToCampaign).toHaveBeenCalledOnce();
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