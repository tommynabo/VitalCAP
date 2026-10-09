import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimProcessingJobs: vi.fn(),
  completeProcessingJob: vi.fn(),
  deferProcessingJob: vi.fn(),
  failProcessingJob: vi.fn(),
  enqueueProcessingJob: vi.fn(),
  getRawCandidateById: vi.fn(),
  refreshSearchSeedQualification: vi.fn(),
  getCampaignById: vi.fn(),
  markRawCandidateProcessed: vi.fn(),
  updateRawCandidateAccountId: vi.fn(),
  findCandidateAccountMatches: vi.fn(),
  resolveCanonicalAccount: vi.fn(),
  insertAccountSource: vi.fn(),
  insertContactPoint: vi.fn(),
  insertContactPointWithStatus: vi.fn(),
  upsertCampaignMembership: vi.fn(),
  getWebsiteEnrichmentStatus: vi.fn(),
  upsertWebsiteEnrichmentStatus: vi.fn(),
  insertWebsiteEvidence: vi.fn(),
  listUnlinkedWebsiteEmailEvidence: vi.fn(),
  enqueueVerificationJob: vi.fn(),
  getVerificationEnv: vi.fn(),
  deriveIncomingIdentitySignals: vi.fn(),
  hasLinkedInEmployerAccount: vi.fn(),
  processRawCandidate: vi.fn(),
  enrichWebsite: vi.fn(),
}));

vi.mock("@/infrastructure/neon/repositories/job-queue", () => ({
  claimProcessingJobs: mocks.claimProcessingJobs,
  completeProcessingJob: mocks.completeProcessingJob,
  deferProcessingJob: mocks.deferProcessingJob,
  failProcessingJob: mocks.failProcessingJob,
  enqueueProcessingJob: mocks.enqueueProcessingJob,
}));

vi.mock("@/infrastructure/neon/repositories/discovery", () => ({
  getRawCandidateById: mocks.getRawCandidateById,
  markRawCandidateProcessed: mocks.markRawCandidateProcessed,
  refreshSearchSeedQualification: mocks.refreshSearchSeedQualification,
  updateRawCandidateAccountId: mocks.updateRawCandidateAccountId,
}));

vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({
  getCampaignById: mocks.getCampaignById,
  upsertCampaignMembership: mocks.upsertCampaignMembership,
}));

vi.mock("@/infrastructure/neon/repositories/accounts", () => ({
  findCandidateAccountMatches: mocks.findCandidateAccountMatches,
  resolveCanonicalAccount: mocks.resolveCanonicalAccount,
  getAccountById: vi.fn(),
  updateAccountFields: vi.fn(),
  insertAccountSource: mocks.insertAccountSource,
  insertContactPoint: mocks.insertContactPoint,
  insertContactPointWithStatus: mocks.insertContactPointWithStatus,
}));

vi.mock("@/infrastructure/neon/repositories/enrichment", () => ({
  getWebsiteEnrichmentStatus: mocks.getWebsiteEnrichmentStatus,
  upsertWebsiteEnrichmentStatus: mocks.upsertWebsiteEnrichmentStatus,
  insertWebsiteEvidence: mocks.insertWebsiteEvidence,
  listUnlinkedWebsiteEmailEvidence: mocks.listUnlinkedWebsiteEmailEvidence,
}));

vi.mock("@/infrastructure/neon/repositories/verification-queue", () => ({
  enqueueVerificationJob: mocks.enqueueVerificationJob,
}));

vi.mock("@/services/discovery/candidate-processor", () => ({
  deriveIncomingIdentitySignals: mocks.deriveIncomingIdentitySignals,
  hasLinkedInEmployerAccount: mocks.hasLinkedInEmployerAccount,
  processRawCandidate: mocks.processRawCandidate,
}));

vi.mock("@/services/enrichment/website-enrichment-service", () => ({
  WebsiteEnrichmentService: class {
    enrich(...args: unknown[]) {
      return mocks.enrichWebsite(...args);
    }
  },
}));

vi.mock("@/infrastructure/jobs/runners/engine-factory", () => ({
  realWebsiteFetcher: { fetchPage: vi.fn() },
  providerLabelForEngine: (engineType: string) => engineType,
}));

vi.mock("@/lib/config/env", () => ({
  getVerificationEnv: mocks.getVerificationEnv,
}));

import { runProcessingCronTick } from "./processing-runner";

function makeJob(id: string) {
  return {
    id,
    campaignId: "campaign-id",
    type: "maps_deep_owner_enrichment",
    payload: { rawCandidateId: "raw-candidate-id" },
    status: "processing",
    attemptCount: 1,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: "worker",
    idempotencyKey: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(0);
  mocks.completeProcessingJob.mockResolvedValue(undefined);
  mocks.deferProcessingJob.mockResolvedValue(undefined);
  mocks.failProcessingJob.mockResolvedValue(undefined);
  mocks.getCampaignById.mockResolvedValue({ workspaceId: "workspace-id" });
  mocks.markRawCandidateProcessed.mockResolvedValue(undefined);
  mocks.updateRawCandidateAccountId.mockResolvedValue(undefined);
  mocks.findCandidateAccountMatches.mockResolvedValue([]);
  mocks.resolveCanonicalAccount.mockResolvedValue({ kind: "createNewAccount", accountId: "account-id" });
  mocks.insertAccountSource.mockResolvedValue(undefined);
  mocks.insertContactPoint.mockResolvedValue("");
  mocks.insertContactPointWithStatus.mockResolvedValue({ id: "contact-point-id", created: true, verificationStatus: "unverified" });
  mocks.upsertCampaignMembership.mockResolvedValue(undefined);
  mocks.getWebsiteEnrichmentStatus.mockResolvedValue(null);
  mocks.upsertWebsiteEnrichmentStatus.mockResolvedValue(undefined);
  mocks.insertWebsiteEvidence.mockResolvedValue(undefined);
  mocks.listUnlinkedWebsiteEmailEvidence.mockResolvedValue([]);
  mocks.enqueueVerificationJob.mockResolvedValue(true);
  mocks.getVerificationEnv.mockReturnValue({ EMAIL_VERIFICATION_PROVIDER: "millionverifier" });
  mocks.deriveIncomingIdentitySignals.mockReturnValue({
    normalizedName: "farmacia ejemplo",
    normalizedDomain: "farmacia-ejemplo.es",
  });
  mocks.hasLinkedInEmployerAccount.mockReturnValue(true);
  mocks.processRawCandidate.mockResolvedValue({
    engineType: "maps_fast",
    accountKey: "domain:farmacia-ejemplo.es",
    businessNameGuess: "Farmacia Ejemplo",
    isDuplicate: false,
    matchedAccountKey: null,
    spainVerdict: "needs_review",
    businessType: "pharmacy",
    icpQualified: true,
    contactPoints: [],
    serperEmailRecovery: { candidatesFound: 0, candidatesRelevant: 0, duplicateCandidatesSkipped: 0 },
    readyForOutreach: false,
    rejectionReason: "Awaiting Spain eligibility review",
  });
  mocks.enrichWebsite.mockResolvedValue({
    status: "completed",
    pagesFetched: 2,
    contentHash: "content-hash",
    evidence: [{
      evidenceType: "email",
      value: "info@farmacia-ejemplo.es",
      normalizedValue: "info@farmacia-ejemplo.es",
      snippet: "Contact information",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
      isGeneric: true,
    }],
  });
  mocks.getRawCandidateById.mockResolvedValue({
    accountId: "account-id",
    rawPayload: { kind: "maps", place: { websiteUrl: null } },
    searchSeedRunId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runProcessingCronTick", () => {
  it("stops claiming before the time budget and leaves later work retryable", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([makeJob("job-1")])
      .mockResolvedValueOnce([makeJob("job-2")]);
    mocks.getRawCandidateById.mockImplementation(async () => {
      elapsed += 300;
      return {
        accountId: "account-id",
        rawPayload: { kind: "maps", place: { websiteUrl: null } },
        searchSeedRunId: null,
      };
    });

    const firstTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });

    expect(firstTick.jobsClaimed).toBe(1);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(1);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 1 }));
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
    expect(mocks.deferProcessingJob).not.toHaveBeenCalled();

    mocks.claimProcessingJobs.mockReset().mockResolvedValueOnce([makeJob("job-2")]).mockResolvedValueOnce([]);
    const secondTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });
    expect(secondTick.jobsClaimed).toBe(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(2);

    mocks.claimProcessingJobs.mockReset().mockResolvedValueOnce([]);
    const thirdTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1000 });
    expect(thirdTick.jobsClaimed).toBe(0);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(2);
  });

  it("completes a normal batch serially", async () => {
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([makeJob("job-1")])
      .mockResolvedValueOnce([makeJob("job-2")])
      .mockResolvedValueOnce([]);

    const result = await runProcessingCronTick(3);

    expect(result.jobsClaimed).toBe(2);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(3);
    expect(mocks.completeProcessingJob.mock.calls.map(([input]) => input.jobId)).toEqual(["job-1", "job-2"]);
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("recovers persisted website email evidence after a failed handoff without recrawling", async () => {
    const rawCandidate = {
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "maps_fast",
      rawPayload: {
        kind: "maps",
        place: {
          externalPlaceId: "place-id",
          name: "Farmacia Ejemplo",
          countryCode: "ES",
          websiteUrl: "https://farmacia-ejemplo.es",
          phone: null,
          sourceUrl: null,
        },
      },
    };
    const normalJob = { ...makeJob("job-retry"), type: "process_raw_candidate" };
    mocks.getRawCandidateById.mockResolvedValue(rawCandidate);
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ nextRefreshAt: new Date(Date.now() + 60_000), status: "completed" });
    mocks.listUnlinkedWebsiteEmailEvidence.mockResolvedValue([{
      value: "info@farmacia-ejemplo.es",
      normalizedValue: "info@farmacia-ejemplo.es",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
    }]);
    mocks.insertContactPointWithStatus
      .mockRejectedValueOnce(new Error("simulated handoff failure"))
      .mockResolvedValueOnce({ id: "contact-point-id", created: true, verificationStatus: "unverified" });
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([normalJob])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([normalJob])
      .mockResolvedValueOnce([]);

    await runProcessingCronTick(3);
    const retry = await runProcessingCronTick(3);

    const failureMessages = mocks.failProcessingJob.mock.calls.map(([input]) =>
      String((input as { error?: unknown }).error),
    );
    expect(failureMessages).toEqual(["Error: simulated handoff failure"]);
    expect(mocks.failProcessingJob).toHaveBeenCalledTimes(1);
    expect(mocks.enrichWebsite).toHaveBeenCalledTimes(1);
    expect(mocks.listUnlinkedWebsiteEmailEvidence).toHaveBeenCalledTimes(2);
    expect(mocks.insertContactPointWithStatus).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueVerificationJob).toHaveBeenCalledWith({
      workspaceId: "workspace-id",
      contactPointId: "contact-point-id",
      normalizedEmail: "info@farmacia-ejemplo.es",
      provider: "millionverifier",
    });
    expect(retry.jobsClaimed).toBe(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
  });

  it("retries a stale transient website cache and queues recovered email as unverified", async () => {
    const rawCandidate = {
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "maps_fast",
      rawPayload: {
        kind: "maps",
        place: {
          externalPlaceId: "place-id",
          name: "Farmacia Ejemplo",
          countryCode: "ES",
          websiteUrl: "https://farmacia-ejemplo.es",
          phone: null,
          sourceUrl: null,
        },
      },
    };
    const normalJob = { ...makeJob("job-transient-retry"), type: "process_raw_candidate" };
    mocks.getRawCandidateById.mockResolvedValue(rawCandidate);
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus.mockResolvedValue({
      status: "timeout",
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      nextRefreshAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    mocks.enrichWebsite.mockResolvedValue({
      status: "completed",
      pagesFetched: 2,
      internalPagesFetched: 1,
      emailCandidatesFound: 1,
      contentHash: "content-hash",
      evidence: [{
        evidenceType: "email",
        value: "info@farmacia-ejemplo.es",
        normalizedValue: "info@farmacia-ejemplo.es",
        snippet: "Contact information",
        sourceUrl: "https://farmacia-ejemplo.es/contacto",
      }],
    });
    mocks.listUnlinkedWebsiteEmailEvidence.mockResolvedValue([{
      value: "info@farmacia-ejemplo.es",
      normalizedValue: "info@farmacia-ejemplo.es",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
    }]);
    mocks.claimProcessingJobs.mockResolvedValueOnce([normalJob]).mockResolvedValueOnce([]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await runProcessingCronTick(3);

    expect(mocks.enrichWebsite).toHaveBeenCalledTimes(1);
    expect(mocks.insertContactPointWithStatus).toHaveBeenCalledWith(expect.objectContaining({
      verificationStatus: "unverified",
      verificationProvider: null,
      sourceType: "website_enrichment",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
    }));
    expect(mocks.enqueueVerificationJob).toHaveBeenCalledWith(expect.objectContaining({
      contactPointId: "contact-point-id",
      normalizedEmail: "info@farmacia-ejemplo.es",
      provider: "millionverifier",
    }));
    expect(info).toHaveBeenCalledWith("WEBSITE_EMAIL_RECOVERY", expect.objectContaining({
      WEBSITE_RECOVERY_ACCOUNTS_ATTEMPTED: 1,
      WEBSITE_RECOVERY_FETCH_FAILED: 0,
      WEBSITE_RECOVERY_INTERNAL_PAGES_FETCHED: 1,
      WEBSITE_EMAIL_CANDIDATES_FOUND: 1,
      WEBSITE_EMAIL_CONTACT_POINTS_CREATED: 1,
      WEBSITE_EMAIL_VERIFICATION_QUEUED: 1,
    }));
  });

  it("does not requeue an already verified website email", async () => {
    const rawCandidate = {
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "maps_fast",
      rawPayload: {
        kind: "maps",
        place: {
          externalPlaceId: "place-id",
          name: "Farmacia Ejemplo",
          countryCode: "ES",
          websiteUrl: "https://farmacia-ejemplo.es",
          phone: null,
          sourceUrl: null,
        },
      },
    };
    mocks.getRawCandidateById.mockResolvedValue(rawCandidate);
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus.mockResolvedValue({
      status: "completed",
      startedAt: new Date(),
      nextRefreshAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    mocks.listUnlinkedWebsiteEmailEvidence.mockResolvedValue([{
      value: "info@farmacia-ejemplo.es",
      normalizedValue: "info@farmacia-ejemplo.es",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
    }]);
    mocks.insertContactPointWithStatus.mockResolvedValue({
      id: "existing-contact-point-id",
      created: false,
      verificationStatus: "valid",
    });
    mocks.claimProcessingJobs.mockResolvedValueOnce([{ ...makeJob("job-existing-email"), type: "process_raw_candidate" }])
      .mockResolvedValueOnce([]);

    await runProcessingCronTick(3);

    expect(mocks.enrichWebsite).not.toHaveBeenCalled();
    expect(mocks.enqueueVerificationJob).not.toHaveBeenCalled();
  });

  it("persists Serper provenance and queues a new snippet email for MillionVerifier", async () => {
    const email = "info@farmacia-ejemplo.es";
    mocks.getRawCandidateById.mockResolvedValue({
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "google_serp",
      rawPayload: {
        kind: "serp",
        result: {
          title: "Farmacia Ejemplo",
          domain: "farmacia-ejemplo.es",
          url: "https://farmacia-ejemplo.es/contacto",
          snippet: `Farmacia Ejemplo ${email}`,
        },
        geography: "Madrid",
      },
    });
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus.mockResolvedValue({
      status: "completed",
      nextRefreshAt: new Date(Date.now() + 60_000),
    });
    mocks.processRawCandidate.mockResolvedValueOnce({
      engineType: "google_serp",
      accountKey: "domain:farmacia-ejemplo.es",
      businessNameGuess: "Farmacia Ejemplo",
      isDuplicate: false,
      matchedAccountKey: null,
      spainVerdict: "needs_review",
      businessType: "pharmacy",
      icpQualified: true,
      contactPoints: [{
        email,
        label: "info",
        isGeneric: true,
        roleType: "generic_role",
        priorityScore: 0,
        verificationStatus: "unverified",
        acceptable: false,
        sourceUrl: "https://farmacia-ejemplo.es/contacto",
        sourceType: "serper_snippet",
        verificationProvider: null,
      }],
      serperEmailRecovery: { candidatesFound: 1, candidatesRelevant: 1, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: "unverified",
    });
    mocks.claimProcessingJobs.mockResolvedValueOnce([{ ...makeJob("serper-job"), type: "process_raw_candidate" }]).mockResolvedValueOnce([]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await runProcessingCronTick(3);

    expect(mocks.insertContactPointWithStatus).toHaveBeenCalledWith(expect.objectContaining({
      value: email,
      normalizedValue: email,
      verificationStatus: "unverified",
      sourceUrl: "https://farmacia-ejemplo.es/contacto",
      sourceType: "serper_snippet",
    }));
    expect(mocks.enqueueVerificationJob).toHaveBeenCalledWith({
      workspaceId: "workspace-id",
      contactPointId: "contact-point-id",
      normalizedEmail: email,
      provider: "millionverifier",
    });
    expect(info).toHaveBeenCalledWith("SERPER_EMAIL_RECOVERY", expect.objectContaining({
      SERPER_EMAIL_CANDIDATES_FOUND: 1,
      SERPER_EMAIL_CANDIDATES_RELEVANT: 1,
      SERPER_EMAIL_CONTACT_POINTS_CREATED: 1,
      SERPER_EMAIL_DUPLICATES_SKIPPED: 0,
      SERPER_EMAIL_VERIFICATION_QUEUED: 1,
    }));
    expect(JSON.stringify(info.mock.calls)).not.toContain(email);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
  });

  it("skips verification queue creation for an existing verified snippet email", async () => {
    mocks.getRawCandidateById.mockResolvedValue({
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "google_serp",
      rawPayload: {
        kind: "serp",
        result: { title: "Farmacia Ejemplo", domain: "farmacia-ejemplo.es", url: "https://farmacia-ejemplo.es", snippet: "" },
        geography: "Madrid",
      },
    });
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus.mockResolvedValue({
      status: "completed",
      nextRefreshAt: new Date(Date.now() + 60_000),
    });
    mocks.processRawCandidate.mockResolvedValueOnce({
      engineType: "google_serp",
      accountKey: "domain:farmacia-ejemplo.es",
      businessNameGuess: "Farmacia Ejemplo",
      isDuplicate: false,
      matchedAccountKey: null,
      spainVerdict: "needs_review",
      businessType: "pharmacy",
      icpQualified: true,
      contactPoints: [{
        email: "info@farmacia-ejemplo.es",
        label: "info",
        isGeneric: true,
        roleType: "generic_role",
        priorityScore: 0,
        verificationStatus: "unverified",
        acceptable: false,
        sourceUrl: "https://farmacia-ejemplo.es",
        sourceType: "serper_snippet",
        verificationProvider: null,
      }],
      serperEmailRecovery: { candidatesFound: 1, candidatesRelevant: 1, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: "unverified",
    });
    mocks.insertContactPointWithStatus.mockResolvedValueOnce({
      id: "existing-contact-point-id",
      created: false,
      verificationStatus: "valid",
    });
    mocks.enqueueVerificationJob.mockClear();
    mocks.claimProcessingJobs.mockResolvedValueOnce([{ ...makeJob("serper-duplicate-job"), type: "process_raw_candidate" }]).mockResolvedValueOnce([]);

    await runProcessingCronTick(3);

    expect(mocks.enqueueVerificationJob).not.toHaveBeenCalled();
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
  });

  it("defers a claimed job if the budget expires before execution", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.claimProcessingJobs.mockImplementation(async () => {
      elapsed = 1000;
      return [makeJob("job-1")];
    });

    const result = await runProcessingCronTick(3, new Date("2026-01-01T00:00:00.000Z"), { timeBudgetMs: 1000 });

    expect(result.jobsClaimed).toBe(0);
    expect(mocks.deferProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    expect(mocks.completeProcessingJob).not.toHaveBeenCalled();
  });
});