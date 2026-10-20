import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import type { MapsPlaceResult } from "@/domain/providers/types";
import type { ProcessedCandidateResult, ProcessingContext } from "@/services/discovery/candidate-processor";

const mocks = vi.hoisted(() => ({
  claimProcessingJobs: vi.fn(),
  completeProcessingJob: vi.fn(),
  deferProcessingJob: vi.fn(),
  failProcessingJob: vi.fn(),
  enqueueProcessingJob: vi.fn(),
  getRawCandidateById: vi.fn(),
  claimMapsFastWebsiteRecovery: vi.fn(),
  updateRawCandidateProcessingMetrics: vi.fn(),
  refreshSearchSeedQualification: vi.fn(),
  getCampaignById: vi.fn(),
  markRawCandidateProcessed: vi.fn(),
  updateRawCandidateAccountId: vi.fn(),
  findCandidateAccountMatches: vi.fn(),
  resolveCanonicalAccount: vi.fn(),
  getAccountById: vi.fn(),
  updateAccountFields: vi.fn(),
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
  createInitialCandidateProcessingMetrics: vi.fn(),
  hasLinkedInEmployerAccount: vi.fn(),
  processRawCandidate: vi.fn(),
  enrichWebsite: vi.fn(),
  createSerpDiscoveryProvider: vi.fn(),
  getAutopilotSettings: vi.fn(),
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
  claimMapsFastWebsiteRecovery: mocks.claimMapsFastWebsiteRecovery,
  updateRawCandidateProcessingMetrics: mocks.updateRawCandidateProcessingMetrics,
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
  getAccountById: mocks.getAccountById,
  updateAccountFields: mocks.updateAccountFields,
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

vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings: mocks.getAutopilotSettings,
}));

vi.mock("@/infrastructure/providers/provider-factory", () => ({
  createSerpDiscoveryProvider: mocks.createSerpDiscoveryProvider,
  ProviderDisabledError: class ProviderDisabledError extends Error {},
}));

vi.mock("@/services/discovery/candidate-processor", () => ({
  deriveIncomingIdentitySignals: mocks.deriveIncomingIdentitySignals,
  createInitialCandidateProcessingMetrics: mocks.createInitialCandidateProcessingMetrics,
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

import {
  evaluateStructuredWebsiteLocation,
  PROCESSING_MAX_JOBS_PER_TICK,
  runProcessingCronTick,
} from "./processing-runner";

describe("evaluateStructuredWebsiteLocation", () => {
  it("rejects conflicting structured country evidence even when another fact has a Spanish postcode", () => {
    const result = evaluateStructuredWebsiteLocation({
      countryCode: null,
      postalCode: null,
      latitude: null,
      longitude: null,
      phone: null,
      normalizedDomain: "farmacia.es",
      province: "Madrid",
      city: null,
    }, [
      { evidenceType: "location_country", value: "Spain", normalizedValue: "ES", snippet: null, sourceUrl: "https://farmacia.es/" },
      { evidenceType: "location_country", value: "Portugal", normalizedValue: "PORTUGAL", snippet: null, sourceUrl: "https://farmacia.es/about" },
      { evidenceType: "location_postal_code", value: "28001", normalizedValue: "28001", snippet: null, sourceUrl: "https://farmacia.es/" },
    ], "farmacia.es");

    expect(result.verdict.verdict).toBe("rejected");
    expect(result.accountUpdates.countryCode).toBeUndefined();
    expect(result.accountUpdates.postalCode).toBe("28001");
  });
});

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

const mapsFastRecoveryPlace: MapsPlaceResult = {
  externalPlaceId: "maps-fast-recovery-place",
  name: "Farmacia Ejemplo",
  category: "farmacia",
  address: "Calle Mayor 1",
  postalCode: "28001",
  province: "Madrid",
  city: "Madrid",
  countryCode: "ES",
  websiteUrl: null,
  phone: "+34 911 111 111",
  latitude: null,
  longitude: null,
  rating: null,
  reviewCount: null,
  sourceUrl: "https://maps.example/place/maps-fast-recovery-place",
};

function prepareMapsFastRecoveryJob(processedOverride: Partial<ProcessedCandidateResult> = {}, payloadExtras: Record<string, unknown> = {}): void {
  mocks.getRawCandidateById.mockResolvedValue({
    id: "raw-candidate-id",
    campaignId: "campaign-id",
    engineType: "maps_fast",
    sourceExternalId: mapsFastRecoveryPlace.externalPlaceId,
    sourceUrl: mapsFastRecoveryPlace.sourceUrl,
    rawPayload: { kind: "maps", place: mapsFastRecoveryPlace },
    processingMetrics: null,
    accountId: null,
    searchSeedRunId: null,
  });
  mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
  mocks.deriveIncomingIdentitySignals.mockReturnValue({ normalizedName: "farmacia ejemplo", normalizedDomain: null });
  mocks.claimProcessingJobs.mockResolvedValueOnce([{
    ...makeJob("maps-fast-recovery"),
    type: "process_raw_candidate",
    payload: { rawCandidateId: "raw-candidate-id", ...payloadExtras },
  }]).mockResolvedValueOnce([]);
  mocks.processRawCandidate.mockImplementationOnce(async (_payload: unknown, engineType: string, context: ProcessingContext) => {
    const recovery = await context.recoverMapsFastWebsite?.(mapsFastRecoveryPlace) ?? { status: "blocked" as const };
    return {
      engineType: engineType as ProcessedCandidateResult["engineType"],
      accountKey: "place:maps-fast-recovery-place",
      businessNameGuess: "Farmacia Ejemplo",
      isDuplicate: false,
      matchedAccountKey: null,
      spainVerdict: "needs_review",
      businessType: "pharmacy",
      icpQualified: true,
      contactPoints: [],
      processingMetrics: { homepageFetchAttempted: 0, homepageFetchSucceeded: 0, homepageFetchFailed: 0, emailRejectedFormat: 0, emailDuplicate: 0 },
      serperEmailRecovery: { candidatesFound: 0, candidatesRelevant: 0, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: "Awaiting Spain eligibility review",
      recoveredWebsite: recovery.status === "recovered" ? recovery.website : null,
      ...processedOverride,
    };
  });
}

const recoveredWebsite = {
  domain: "farmacia-ejemplo.es",
  websiteUrl: "https://farmacia-ejemplo.es/",
  evidence: {
    title: "Farmacia Ejemplo Madrid",
    url: "https://farmacia-ejemplo.es/contacto",
    snippet: "Farmacia Ejemplo Madrid 911111111",
    domain: "farmacia-ejemplo.es",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(0);
  mocks.completeProcessingJob.mockResolvedValue(undefined);
  mocks.deferProcessingJob.mockResolvedValue(undefined);
  mocks.failProcessingJob.mockResolvedValue(undefined);
  mocks.getCampaignById.mockResolvedValue({ workspaceId: "workspace-id" });
  mocks.markRawCandidateProcessed.mockResolvedValue(undefined);
  mocks.updateRawCandidateAccountId.mockResolvedValue(undefined);
  mocks.findCandidateAccountMatches.mockResolvedValue([]);
  mocks.resolveCanonicalAccount.mockResolvedValue({ kind: "createNewAccount", accountId: "account-id" });
  mocks.getAccountById.mockResolvedValue(null);
  mocks.updateAccountFields.mockResolvedValue(undefined);
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
  mocks.createInitialCandidateProcessingMetrics.mockReturnValue({
    homepageFetchAttempted: 0,
    homepageFetchSucceeded: 0,
    homepageFetchFailed: 0,
    emailRejectedFormat: 0,
    emailDuplicate: 0,
    websiteOrigin: "none",
    websiteEmailAttributionComplete: true,
  });
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
    processingMetrics: { homepageFetchAttempted: 0, homepageFetchSucceeded: 0, homepageFetchFailed: 0, emailRejectedFormat: 0, emailDuplicate: 0 },
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
    id: "raw-candidate-id",
    engineType: "maps_fast",
    accountId: "account-id",
    rawPayload: { kind: "maps", place: { websiteUrl: null } },
    processingMetrics: null,
    searchSeedRunId: null,
  });
  mocks.claimMapsFastWebsiteRecovery.mockResolvedValue(true);
  mocks.updateRawCandidateProcessingMetrics.mockResolvedValue(undefined);
  mocks.getAutopilotSettings.mockResolvedValue({ enabled: true, systemPaused: false, emergencyStopped: false, timezone: "Europe/Madrid" });
  mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "mock", search: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runProcessingCronTick", () => {
  it("does not construct a Serper provider while Autopilot is paused", async () => {
    prepareMapsFastRecoveryJob();
    mocks.getAutopilotSettings.mockResolvedValue({ enabled: true, systemPaused: true, emergencyStopped: false, timezone: "Europe/Madrid" });

    await runProcessingCronTick(1);

    expect(mocks.createSerpDiscoveryProvider).not.toHaveBeenCalled();
    expect(mocks.claimMapsFastWebsiteRecovery).not.toHaveBeenCalled();
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("does not claim or search when Serper is unavailable", async () => {
    prepareMapsFastRecoveryJob();
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "mock", search: vi.fn() });

    await runProcessingCronTick(1);

    expect(mocks.processRawCandidate).toHaveBeenCalledOnce();
    expect(mocks.createSerpDiscoveryProvider).toHaveBeenCalledWith("workspace-id", "maps_fast", "campaign-id");
    expect(mocks.claimMapsFastWebsiteRecovery).not.toHaveBeenCalled();
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("treats a Serper budget block as a safe no-website outcome", async () => {
    prepareMapsFastRecoveryJob();
    const search = vi.fn().mockRejectedValue(new ProviderBudgetExceededError("Serper daily budget exhausted", new Date("2026-10-20T00:00:00Z")));
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "serper", search });

    await runProcessingCronTick(1);

    expect(search).toHaveBeenCalledOnce();
    expect(mocks.updateRawCandidateProcessingMetrics).toHaveBeenCalledWith("raw-candidate-id", expect.objectContaining({
      websiteRecoveryAttempted: 0,
      websiteRecoveryStatus: "budget_blocked",
    }));
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
    expect(mocks.completeProcessingJob).toHaveBeenCalledOnce();
  });

  it("does not repeat a paid lookup when the persisted atomic claim is already held", async () => {
    prepareMapsFastRecoveryJob();
    const search = vi.fn();
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "serper", search });
    mocks.claimMapsFastWebsiteRecovery.mockResolvedValue(false);

    await runProcessingCronTick(1);

    expect(mocks.claimMapsFastWebsiteRecovery).toHaveBeenCalledWith("raw-candidate-id");
    expect(search).not.toHaveBeenCalled();
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("persists a recovered domain as Serper evidence and uses it for canonical account enrichment", async () => {
    prepareMapsFastRecoveryJob();
    const search = vi.fn().mockResolvedValue({
      results: [recoveredWebsite.evidence],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 10, costUsd: 0.001, quotaRemaining: null },
    });
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "serper", search });

    await runProcessingCronTick(1);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: '"Farmacia Ejemplo" Madrid', maxResults: 5 }));
    expect(mocks.resolveCanonicalAccount).toHaveBeenCalledWith("workspace-id", expect.objectContaining({ normalizedDomain: "farmacia-ejemplo.es" }), expect.objectContaining({
      websiteUrl: "https://farmacia-ejemplo.es/",
      normalizedDomain: "farmacia-ejemplo.es",
    }), expect.anything());
    expect(mocks.insertAccountSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "maps_fast",
      sourceProvider: "serper",
      sourceUrl: recoveredWebsite.evidence.url,
      rawSnapshot: expect.objectContaining({ kind: "maps_fast_website_recovery", provider: "serper" }),
    }));
    expect(mocks.getWebsiteEnrichmentStatus).toHaveBeenCalledWith("account-id", "farmacia-ejemplo.es");
  });

  it("persists recovered deep-fetch attribution separately from the candidate homepage fetch", async () => {
    prepareMapsFastRecoveryJob({
      processingMetrics: {
        homepageFetchAttempted: 1,
        homepageFetchSucceeded: 1,
        homepageFetchFailed: 0,
        emailRejectedFormat: 0,
        emailDuplicate: 0,
        websiteOrigin: "recovered",
        websiteRecoveryStatus: "succeeded",
        websiteRecoveryAttempted: 1,
        websiteRecoverySucceeded: 1,
        websiteRecoveryFailed: 0,
        recoveredWebsiteDomain: recoveredWebsite.domain,
        recoveredWebsiteUrl: recoveredWebsite.websiteUrl,
        recoveredWebsiteFetchAttempted: 1,
        recoveredWebsiteFetchSucceeded: 1,
        recoveredWebsiteFetchFailed: 0,
        websiteAttributionStartedAt: "2026-10-20T08:00:00.000Z",
        websiteEmailAttributionComplete: true,
      },
    });
    const search = vi.fn().mockResolvedValue({
      results: [recoveredWebsite.evidence],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 10, costUsd: 0.001, quotaRemaining: null },
    });
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "serper", search });

    await runProcessingCronTick(1);

    expect(mocks.markRawCandidateProcessed).toHaveBeenCalledWith("raw-candidate-id", expect.objectContaining({
      websiteOrigin: "recovered",
      homepageFetchSucceeded: 1,
      recoveredWebsiteFetchAttempted: 1,
      recoveredWebsiteFetchSucceeded: 1,
      recoveredWebsiteFetchFailed: 0,
      recoveredWebsiteEnrichmentFetchAttempted: 1,
      recoveredWebsiteEnrichmentFetchSucceeded: 1,
      recoveredWebsiteEnrichmentFetchFailed: 0,
      websiteAttributionCompletedAt: expect.any(String),
    }));
  });

  it("completes a bounded raw recovery attempt without invoking the Maps Fast Serper fallback", async () => {
    prepareMapsFastRecoveryJob({}, {
      recoveryAttempt: 1,
      recoveryDisposition: "recoverable",
      skipMapsFastWebsiteRecovery: true,
    });

    await runProcessingCronTick(1);

    expect(mocks.createSerpDiscoveryProvider).not.toHaveBeenCalled();
    expect(mocks.markRawCandidateProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "maps-fast-recovery" }));
  });

  it("marks a recovered candidate incomplete when its email contact point already existed", async () => {
    prepareMapsFastRecoveryJob({
      processingMetrics: {
        homepageFetchAttempted: 1,
        homepageFetchSucceeded: 1,
        homepageFetchFailed: 0,
        emailRejectedFormat: 0,
        emailDuplicate: 0,
        websiteOrigin: "recovered",
        websiteRecoveryStatus: "succeeded",
        websiteRecoveryAttempted: 1,
        websiteRecoverySucceeded: 1,
        websiteRecoveryFailed: 0,
        recoveredWebsiteDomain: recoveredWebsite.domain,
        recoveredWebsiteUrl: recoveredWebsite.websiteUrl,
        recoveredWebsiteFetchAttempted: 1,
        recoveredWebsiteFetchSucceeded: 1,
        recoveredWebsiteFetchFailed: 0,
        websiteEmailAttributionComplete: true,
      },
      contactPoints: [{
        email: "info@farmacia-ejemplo.es",
        label: "info",
        isGeneric: true,
        roleType: "generic_role",
        priorityScore: 1,
        verificationStatus: "valid",
        acceptable: true,
        sourceUrl: recoveredWebsite.websiteUrl,
        sourceType: "website",
        extractionMethod: "literal",
        verificationProvider: "millionverifier",
      }],
    });
    mocks.createSerpDiscoveryProvider.mockReturnValue({ providerName: "serper", search: vi.fn().mockResolvedValue({
      results: [recoveredWebsite.evidence],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 10, costUsd: 0.001, quotaRemaining: null },
    }) });
    mocks.insertContactPointWithStatus.mockResolvedValueOnce({ id: "existing-contact-point", created: false, verificationStatus: "valid" });

    await runProcessingCronTick(1);

    expect(mocks.markRawCandidateProcessed).toHaveBeenCalledWith("raw-candidate-id", expect.objectContaining({
      websiteContactPointDuplicates: 1,
      websiteEmailAttributionComplete: false,
      websiteEmailSource: "unattributed",
    }));
  });

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
    let activeJobs = 0;
    let maximumActiveJobs = 0;
    mocks.processRawCandidate.mockImplementation(async () => {
      activeJobs += 1;
      maximumActiveJobs = Math.max(maximumActiveJobs, activeJobs);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeJobs -= 1;
      return {
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
      };
    });
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([{ ...makeJob("job-1"), type: "process_raw_candidate" }])
      .mockResolvedValueOnce([{ ...makeJob("job-2"), type: "process_raw_candidate" }])
      .mockResolvedValueOnce([]);

    const result = await runProcessingCronTick(3);

    expect(result.jobsClaimed).toBe(2);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(3);
    expect(mocks.completeProcessingJob.mock.calls.map(([input]) => input.jobId)).toEqual(["job-1", "job-2"]);
    expect(maximumActiveJobs).toBe(1);
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("meets the capacity target with eight sequential P90-duration jobs", async () => {
    const config = JSON.parse(readFileSync(new URL("../../../../vercel.json", import.meta.url), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const processSchedule = config.crons.find((cron) => cron.path === "/api/cron/process")?.schedule;
    expect(processSchedule).toBe("*/5 * * * *");

    const runsPerDay = 24 * 60 / 5;
    const designCapacityPerDay = PROCESSING_MAX_JOBS_PER_TICK * runsPerDay;
    const observedJobsPerRawCandidate = 124 / 117;
    const requiredWithHeadroom = 1500 * observedJobsPerRawCandidate * 1.25;
    expect(PROCESSING_MAX_JOBS_PER_TICK).toBe(8);
    expect(designCapacityPerDay).toBe(2304);
    expect(designCapacityPerDay).toBeGreaterThan(requiredWithHeadroom);

    let elapsedMs = 0;
    let claimed = 0;
    const p90CronDurationMs = 37_542;
    const representativeJobDurationMs = p90CronDurationMs / 3;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    mocks.claimProcessingJobs.mockImplementation(async () => {
      if (claimed >= PROCESSING_MAX_JOBS_PER_TICK) return [];
      claimed += 1;
      return [makeJob(`capacity-job-${claimed}`)];
    });
    mocks.getRawCandidateById.mockImplementation(async () => {
      elapsedMs += representativeJobDurationMs / 2;
      return {
        accountId: "account-id",
        rawPayload: { kind: "maps", place: { websiteUrl: null } },
        searchSeedRunId: null,
      };
    });

    const result = await runProcessingCronTick(PROCESSING_MAX_JOBS_PER_TICK, new Date(), { timeBudgetMs: 240_000 });

    expect(result.jobsClaimed).toBe(8);
    expect(result.jobsCompleted).toBe(8);
    expect(result.durationMs).toBe(100_112);
    expect(result.durationMs).toBeLessThan(240_000 - 90_000);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(8);
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
  });

  it("continues with a healthy job when the previous job times out", async () => {
    const slowJob = { ...makeJob("slow-job"), type: "process_raw_candidate" };
    const healthyJob = { ...makeJob("healthy-job"), type: "process_raw_candidate" };
    mocks.claimProcessingJobs
      .mockResolvedValueOnce([slowJob])
      .mockResolvedValueOnce([healthyJob])
      .mockResolvedValueOnce([]);
    mocks.processRawCandidate
      .mockImplementationOnce((_payload, _engineType, context: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const rejectOnAbort = () => reject(context.signal?.reason);
          context.signal?.addEventListener("abort", rejectOnAbort, { once: true });
          if (context.signal?.aborted) rejectOnAbort();
        }),
      )
      .mockResolvedValueOnce({
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

    const result = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1_000, perJobBudgetMs: 40 });

    expect(result.jobsClaimed).toBe(2);
    expect(result.jobsTimedOut).toBe(1);
    expect(result.jobsCompleted).toBe(1);
    expect(mocks.failProcessingJob).toHaveBeenCalledTimes(1);
    expect(mocks.failProcessingJob).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ id: "slow-job" }) }));
    expect(mocks.completeProcessingJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "healthy-job" }));
  });

  it("defers provider-budget errors without consuming retry attempts", async () => {
    const job = { ...makeJob("budget-job"), type: "process_raw_candidate" };
    const retryAt = new Date("2026-10-12T15:00:00.000Z");
    mocks.claimProcessingJobs.mockResolvedValueOnce([job]).mockResolvedValueOnce([]);
    mocks.processRawCandidate.mockRejectedValueOnce(new ProviderBudgetExceededError("Serper daily budget exhausted", retryAt));

    const result = await runProcessingCronTick(3);

    expect(result.jobsClaimed).toBe(1);
    expect(result.jobsTimedOut).toBe(0);
    expect(mocks.deferProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "budget-job",
      nextAttemptAt: retryAt,
      reason: "Serper daily budget exhausted",
    }));
    expect(mocks.failProcessingJob).not.toHaveBeenCalled();
    expect(mocks.completeProcessingJob).not.toHaveBeenCalled();
  });

  it("enqueues the Maps Deep owner job with a raw-candidate idempotency key", async () => {
    const rawCandidate = {
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "maps_deep",
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
    mocks.claimProcessingJobs.mockResolvedValueOnce([{ ...makeJob("maps-deep-job"), type: "process_raw_candidate" }])
      .mockResolvedValueOnce([]);

    await runProcessingCronTick(2);

    expect(mocks.enqueueProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-id",
      type: "maps_deep_owner_enrichment",
      payload: { rawCandidateId: "raw-candidate-id" },
      idempotencyKey: "maps_deep_owner:raw-candidate-id",
    }));
  });

  it("times out one slow job, preserves retry semantics, and runs a later healthy job on the next tick", async () => {
    const slowJob = { ...makeJob("slow-job"), type: "process_raw_candidate" };
    const healthyJob = makeJob("healthy-job");
    mocks.claimProcessingJobs.mockResolvedValueOnce([slowJob]).mockResolvedValueOnce([]);
    mocks.processRawCandidate.mockImplementation((_payload, _engineType, context: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = context.signal;
        const rejectOnAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", rejectOnAbort, { once: true });
        if (signal?.aborted) rejectOnAbort();
      }),
    );

    const staleTickTime = new Date(Date.now() - 60_000);
    const firstTick = await runProcessingCronTick(3, staleTickTime, { timeBudgetMs: 1_000, perJobBudgetMs: 40 });

    expect(firstTick.jobsClaimed).toBe(1);
    expect(firstTick.jobsCompleted).toBe(0);
    expect(firstTick.jobsTimedOut).toBe(1);
    expect(mocks.claimProcessingJobs).toHaveBeenCalledTimes(2);
    expect(mocks.failProcessingJob).toHaveBeenCalledTimes(1);
    expect(mocks.failProcessingJob).toHaveBeenCalledWith(expect.objectContaining({
      job: expect.objectContaining({ id: "slow-job", attemptCount: 1, maxAttempts: 5 }),
      error: expect.objectContaining({ code: "PROCESSING_JOB_TIMEOUT" }),
      now: expect.any(Date),
    }));
    expect((mocks.failProcessingJob.mock.calls[0]?.[0] as { now: Date }).now.getTime()).toBeGreaterThan(staleTickTime.getTime());
    expect(mocks.completeProcessingJob).not.toHaveBeenCalled();

    mocks.claimProcessingJobs.mockReset().mockResolvedValueOnce([healthyJob]).mockResolvedValueOnce([]);
    const secondTick = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 1_000 });

    expect(secondTick.jobsCompleted).toBe(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "healthy-job" }));
    expect(mocks.failProcessingJob).toHaveBeenCalledTimes(1);
  });

  it("returns before the total cron budget when a claim operation stalls", async () => {
    mocks.claimProcessingJobs.mockReturnValue(new Promise(() => {}));
    const startedAt = performance.now();

    const result = await runProcessingCronTick(3, new Date(), { timeBudgetMs: 80 });

    expect(result.jobsClaimed).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(80);
  });

  it("propagates claim failures that did not come from the cron deadline", async () => {
    mocks.claimProcessingJobs.mockRejectedValue(new Error("Neon claim failed"));

    await expect(runProcessingCronTick(3)).rejects.toThrow("Neon claim failed");
  });

  it("does not retry a job after completion if later seed bookkeeping fails", async () => {
    const completedJob = makeJob("completed-job");
    const rawCandidate = {
      accountId: "account-id",
      rawPayload: { kind: "maps", place: { websiteUrl: null } },
      searchSeedRunId: null,
    };
    mocks.getRawCandidateById
      .mockResolvedValueOnce(rawCandidate)
      .mockRejectedValueOnce(new Error("seed bookkeeping failed"))
      .mockResolvedValueOnce(rawCandidate);
    mocks.claimProcessingJobs.mockResolvedValueOnce([completedJob]).mockResolvedValueOnce([]);

    const result = await runProcessingCronTick(3);

    expect(result.jobsCompleted).toBe(1);
    expect(mocks.completeProcessingJob).toHaveBeenCalledTimes(1);
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
      emailExtractionLiteralFound: 0,
      emailExtractionDeobfuscatedFound: 1,
      targetContactPagesFetched: 1,
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
      EMAIL_EXTRACTION_LITERAL_FOUND: 0,
      EMAIL_EXTRACTION_DEOBFUSCATED_FOUND: 1,
      TARGET_CONTACT_PAGE_FETCHED: 1,
      WEBSITE_EMAIL_CONTACT_POINTS_CREATED: 1,
      WEBSITE_EMAIL_VERIFICATION_QUEUED: 1,
    }));
    expect(mocks.markRawCandidateProcessed).toHaveBeenCalledWith("raw-candidate-id", expect.objectContaining({
      websiteEmailExtractionLiteralFound: 0,
      websiteEmailExtractionDeobfuscatedFound: 1,
      websiteTargetContactPagesFetched: 1,
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

  it("qualifies a Serper account from persisted structured website evidence through the Spain evaluator", async () => {
    const email = "info@farmacia-ejemplo.es";
    const sourceUrl = "https://farmacia-ejemplo.es/contacto";
    mocks.resolveCanonicalAccount.mockResolvedValueOnce({ kind: "existingAccount", existingAccountId: "canonical-account-id" });
    mocks.getRawCandidateById.mockResolvedValue({
      id: "raw-candidate-id",
      accountId: null,
      searchSeedRunId: null,
      engineType: "google_serp",
      rawPayload: {
        kind: "serp",
        result: { title: "Farmacia Ejemplo", domain: "farmacia-ejemplo.es", url: "https://farmacia-ejemplo.es", snippet: "Farmacia Madrid" },
        geography: "Madrid",
      },
    });
    mocks.getCampaignById.mockResolvedValue({ id: "campaign-id", workspaceId: "workspace-id" });
    mocks.getWebsiteEnrichmentStatus.mockResolvedValue(null);
    mocks.getAccountById.mockResolvedValue({
      id: "canonical-account-id",
      status: "needs_review",
      countryCode: "ES",
      postalCode: null,
      latitude: null,
      longitude: null,
      phone: null,
      normalizedDomain: "farmacia-ejemplo.es",
      province: "Madrid",
      city: null,
    });
    mocks.enrichWebsite.mockResolvedValue({
      status: "completed",
      pagesFetched: 1,
      internalPagesFetched: 0,
      emailCandidatesFound: 0,
      contentHash: "structured-content-hash",
      evidence: [
        { evidenceType: "location_country", value: "Spain", normalizedValue: "ES", snippet: "Structured JSON-LD location data", sourceUrl },
        { evidenceType: "location_postal_code", value: "28001", normalizedValue: "28001", snippet: "Structured JSON-LD location data", sourceUrl },
        { evidenceType: "location_latitude", value: "40.4168", normalizedValue: "40.4168", snippet: "Structured JSON-LD location data", sourceUrl },
        { evidenceType: "location_longitude", value: "-3.7038", normalizedValue: "-3.7038", snippet: "Structured JSON-LD location data", sourceUrl },
      ],
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
        sourceUrl,
        sourceType: "serper_snippet",
        verificationProvider: null,
      }],
      processingMetrics: { homepageFetchAttempted: 0, homepageFetchSucceeded: 0, homepageFetchFailed: 0, emailRejectedFormat: 0, emailDuplicate: 0 },
      serperEmailRecovery: { candidatesFound: 1, candidatesRelevant: 1, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: "Awaiting Spain evidence",
    });
    mocks.claimProcessingJobs.mockResolvedValueOnce([{ ...makeJob("serper-jsonld-job"), type: "process_raw_candidate" }]).mockResolvedValueOnce([]);

    await runProcessingCronTick(3);

    expect(mocks.insertWebsiteEvidence).toHaveBeenCalledTimes(4);
    expect(mocks.insertWebsiteEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceType: "location_postal_code",
      value: "28001",
      sourceUrl,
    }));
    expect(mocks.resolveCanonicalAccount).toHaveBeenCalledTimes(1);
    expect(mocks.insertAccountSource).toHaveBeenCalledTimes(1);
    expect(mocks.insertAccountSource).toHaveBeenCalledWith(expect.objectContaining({ accountId: "canonical-account-id" }));
    expect(mocks.updateAccountFields).toHaveBeenCalledWith("canonical-account-id", expect.objectContaining({
      postalCode: "28001",
      latitude: 40.4168,
      longitude: -3.7038,
      status: "no_contact_found",
    }));
    expect(mocks.upsertCampaignMembership).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-id",
      accountId: "canonical-account-id",
      stage: "qualified",
      rejectionReason: null,
    }));
    expect(mocks.enqueueVerificationJob).toHaveBeenCalledWith(expect.objectContaining({
      normalizedEmail: email,
      provider: "millionverifier",
    }));
  });

  it("persists website and Serper provenance and queues a new snippet email for MillionVerifier", async () => {
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
      }, {
        email: "contact@farmacia-ejemplo.es",
        label: "contact",
        isGeneric: true,
        roleType: "generic_role",
        priorityScore: 0,
        verificationStatus: "unverified",
        acceptable: false,
        sourceUrl: "https://farmacia-ejemplo.es/contacto",
        sourceType: "website",
        verificationProvider: null,
      }],
      processingMetrics: { homepageFetchAttempted: 0, homepageFetchSucceeded: 0, homepageFetchFailed: 0, emailRejectedFormat: 0, emailDuplicate: 0 },
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
    expect(mocks.insertContactPointWithStatus).toHaveBeenCalledWith(expect.objectContaining({
      value: "contact@farmacia-ejemplo.es",
      sourceType: "website",
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
    expect(mocks.markRawCandidateProcessed).toHaveBeenCalledWith("raw-candidate-id", expect.objectContaining({
      homepageFetchAttempted: 0,
      emailRejectedFormat: 0,
      emailDuplicate: 0,
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