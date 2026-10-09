import { randomUUID } from "node:crypto";
import type { AccountStatus } from "@/domain/accounts/types";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import type { CampaignMembershipStage } from "@/domain/campaigns/types";
import { getCampaignById } from "@/infrastructure/neon/repositories/campaigns";
import { upsertCampaignMembership } from "@/infrastructure/neon/repositories/campaigns";
import {
  claimProcessingJobs,
  completeProcessingJob,
  deferProcessingJob,
  failProcessingJob,
  enqueueProcessingJob,
} from "@/infrastructure/neon/repositories/job-queue";
import { getRawCandidateById, markRawCandidateProcessed, refreshSearchSeedQualification, updateRawCandidateAccountId } from "@/infrastructure/neon/repositories/discovery";
import {
  findCandidateAccountMatches,
  getAccountById,
  insertAccountSource,
  insertContactPoint,
  insertContactPointWithStatus,
  resolveCanonicalAccount,
  updateAccountFields,
} from "@/infrastructure/neon/repositories/accounts";
import { createSerpDiscoveryProvider } from "@/infrastructure/providers/provider-factory";
import { createInMemoryVerificationCacheStore } from "@/services/verification/email-verification-cache";
import type { EmailVerificationProvider, WebsiteFetcher } from "@/domain/providers/types";
import { enqueueVerificationJob } from "@/infrastructure/neon/repositories/verification-queue";
import { getVerificationEnv } from "@/lib/config/env";
import { processRawCandidate, deriveIncomingIdentitySignals, hasLinkedInEmployerAccount, type CandidateRawPayload, type ProcessedCandidateResult } from "@/services/discovery/candidate-processor";
import { mergeMissingAccountFields, type IncomingAccountFields } from "@/services/accounts/account-enrichment-merge";
import { realWebsiteFetcher, providerLabelForEngine } from "./engine-factory";
import { WebsiteEnrichmentService } from "@/services/enrichment/website-enrichment-service";
import { getWebsiteEnrichmentStatus, upsertWebsiteEnrichmentStatus, insertWebsiteEvidence, listUnlinkedWebsiteEmailEvidence } from "@/infrastructure/neon/repositories/enrichment";
import { DomainFetchCache } from "@/lib/security/safe-fetch";
import { normalizeDomain } from "@/lib/normalization";

interface ProcessingJobPayload {
  rawCandidateId: string;
}

export interface ProcessingRunnerOptions {
  enrichContacts?: boolean;
  campaignId?: string;
  timeBudgetMs?: number;
}

export const PROCESSING_CRON_TIME_BUDGET_MS = 240_000;
const PROCESSING_JOB_START_RESERVE_MS = 90_000;

const smokeWebsiteFetcher: WebsiteFetcher = {
  fetchPage: async () => {
    throw new Error("Website enrichment disabled for the Maps smoke test.");
  },
};

const smokeVerificationProvider: EmailVerificationProvider = {
  providerName: "disabled-smoke",
  verifyBatch: async () => ({
    outcomes: [],
    usage: { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null },
  }),
};

function resolveAccountStatus(processed: ProcessedCandidateResult): AccountStatus {
  if (processed.spainVerdict === "rejected") return "rejected_country";
  if (!processed.icpQualified) return "rejected_icp";
  if (processed.spainVerdict === "needs_review") return "needs_review";
  if (processed.readyForOutreach) return "contactable";
  return "no_contact_found";
}

function resolveMembershipStage(processed: ProcessedCandidateResult): { stage: CampaignMembershipStage; rejectionReason: string | null } {
  if (processed.readyForOutreach) return { stage: "ready", rejectionReason: null };
  if (processed.spainVerdict === "rejected") return { stage: "rejected", rejectionReason: processed.rejectionReason };
  if (!processed.icpQualified) return { stage: "rejected", rejectionReason: processed.rejectionReason };
  if (processed.spainVerdict === "needs_review") return { stage: "discovered", rejectionReason: processed.rejectionReason };
  return { stage: "qualified", rejectionReason: processed.rejectionReason };
}

function extractAccountFields(payload: CandidateRawPayload): {
  canonicalName: string;
  countryCode: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  addressLine: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  websiteUrl: string | null;
  googlePlaceId: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
} {
  if (payload.kind === "maps") {
    const place = payload.place;
    return {
      canonicalName: place.name,
      countryCode: place.countryCode,
      province: place.province,
      city: place.city,
      postalCode: place.postalCode,
      addressLine: place.address,
      latitude: place.latitude,
      longitude: place.longitude,
      phone: place.phone,
      websiteUrl: place.websiteUrl,
      googlePlaceId: place.externalPlaceId,
      mapsUrl: place.sourceUrl,
      rating: place.rating,
      reviewCount: place.reviewCount,
    };
  }
  if (payload.kind === "serp") {
    return {
      canonicalName: payload.result.title,
      countryCode: null,
      province: payload.geography,
      city: null,
      postalCode: null,
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: null,
      websiteUrl: payload.result.domain ? `https://${payload.result.domain}/` : null,
      googlePlaceId: null,
      mapsUrl: null,
      rating: null,
      reviewCount: null,
    };
  }
  return {
    canonicalName: payload.profile.title,
    countryCode: null,
    province: payload.geography,
    city: null,
    postalCode: null,
    addressLine: null,
    latitude: null,
    longitude: null,
    phone: null,
    websiteUrl: payload.resolvedEmployerDomain ? `https://${payload.resolvedEmployerDomain}/` : null,
    googlePlaceId: null,
    mapsUrl: null,
    rating: null,
    reviewCount: null,
  };
}

async function executeProcessingJob(
  job: { id: string; campaignId: string; type: string; payload: ProcessingJobPayload },
  options: ProcessingRunnerOptions,
): Promise<void> {
  if (job.type === "maps_deep_owner_enrichment") {
    const raw = await getRawCandidateById(job.payload.rawCandidateId);
    if (!raw || raw.rawPayload === undefined || !raw.accountId) throw new Error(`Maps Deep owner enrichment has no processed account for raw_candidate ${job.payload.rawCandidateId}`);
    const campaign = await getCampaignById(job.campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${job.campaignId}`);
    const payload = raw.rawPayload as unknown as CandidateRawPayload;
    if (payload.kind !== "maps") throw new Error(`Maps Deep owner enrichment requires a Maps payload for raw_candidate ${raw.id}`);
    const domain = normalizeDomain(payload.place.websiteUrl);
    if (!domain) return;

    const query = `site:${domain} (titular OR propietario OR gerente OR "responsable de compras" OR "farmacéutico titular")`;
    const provider = createSerpDiscoveryProvider(campaign.workspaceId, "maps_deep", campaign.id);
    const output = await provider.search({ query, maxResults: 5 });
    for (const result of output.results) {
      if (normalizeDomain(result.domain) !== domain) continue;
      await insertAccountSource({
        accountId: raw.accountId,
        sourceType: "maps_deep",
        sourceProvider: "serper",
        sourceExternalId: result.url,
        sourceUrl: result.url,
        rawSnapshot: { kind: "maps_deep_owner_enrichment", query, result, googlePlaceId: payload.place.externalPlaceId },
      });
    }
    return;
  }

  const raw = await getRawCandidateById(job.payload.rawCandidateId);
  if (!raw || raw.rawPayload === undefined) throw new Error(`raw_candidate not found: ${job.payload.rawCandidateId}`);

  const campaign = await getCampaignById(job.campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${job.campaignId}`);

  const payload = raw.rawPayload as unknown as CandidateRawPayload;
  const incoming = deriveIncomingIdentitySignals(payload);
  const existingAccounts = await findCandidateAccountMatches(campaign.workspaceId, incoming);
  if (!hasLinkedInEmployerAccount(payload, existingAccounts)) {
    await markRawCandidateProcessed(raw.id);
    return;
  }

  const fetchCache = new DomainFetchCache();
  const cachedFetcher = {
    fetchPage: async (url: string) => {
      const cached = fetchCache.get(url);
      if (cached) return cached;
      const res = await realWebsiteFetcher.fetchPage(url);
      if (res.status < 400) fetchCache.set(url, res);
      return res;
    },
  };

  const processed = await processRawCandidate(payload, raw.engineType, {
    existingAccounts,
    websiteFetcher: options.enrichContacts === false ? smokeWebsiteFetcher : cachedFetcher,
    verificationProvider: smokeVerificationProvider,
    verificationCacheStore: createInMemoryVerificationCacheStore(),
    now: new Date(),
    deferVerification: true,
  });

  const accountFields = extractAccountFields(payload);
  const incomingAccountFields: IncomingAccountFields = {
    phone: accountFields.phone,
    normalizedPhone: incoming.normalizedPhone ?? null,
    websiteUrl: accountFields.websiteUrl,
    normalizedDomain: incoming.normalizedDomain ?? null,
    googlePlaceId: accountFields.googlePlaceId,
    mapsUrl: accountFields.mapsUrl,
    addressLine: accountFields.addressLine,
    normalizedAddress: incoming.normalizedAddress ?? null,
    city: accountFields.city,
    province: accountFields.province,
    postalCode: accountFields.postalCode,
    latitude: accountFields.latitude,
    longitude: accountFields.longitude,
    rating: accountFields.rating,
    reviewCount: accountFields.reviewCount,
    countryCode: accountFields.countryCode,
  };
  const providerLabel = providerLabelForEngine(raw.engineType);

  const canonicalResolution = await resolveCanonicalAccount(
    campaign.workspaceId,
    incoming,
    {
      workspaceId: campaign.workspaceId,
      canonicalName: accountFields.canonicalName,
      normalizedName: incoming.normalizedName,
      businessType: processed.businessType,
      countryCode: accountFields.countryCode,
      region: null,
      province: accountFields.province,
      city: accountFields.city,
      postalCode: accountFields.postalCode,
      addressLine: accountFields.addressLine,
      normalizedAddress: incoming.normalizedAddress ?? null,
      latitude: accountFields.latitude,
      longitude: accountFields.longitude,
      phone: accountFields.phone,
      normalizedPhone: incoming.normalizedPhone ?? null,
      websiteUrl: accountFields.websiteUrl,
      normalizedDomain: incoming.normalizedDomain ?? null,
      googlePlaceId: accountFields.googlePlaceId,
      mapsUrl: accountFields.mapsUrl,
      rating: accountFields.rating,
      reviewCount: accountFields.reviewCount,
      status: resolveAccountStatus(processed),
    },
    { allowCreate: raw.engineType !== "linkedin_owner" },
  );

  if (canonicalResolution.kind === "needsReview") {
    await markRawCandidateProcessed(raw.id);
    return;
  }

  let accountId: string;
  if (canonicalResolution.kind === "existingAccount") {
    accountId = canonicalResolution.existingAccountId;
    const existingAccount = await getAccountById(accountId);
    if (existingAccount) {
      const missingFields = mergeMissingAccountFields(existingAccount, incomingAccountFields);
      await updateAccountFields(accountId, missingFields);
    }
    await insertAccountSource({
      accountId,
      sourceType: raw.engineType,
      sourceProvider: providerLabel,
      sourceExternalId: raw.sourceExternalId,
      sourceUrl: raw.sourceUrl,
      rawSnapshot: raw.rawPayload,
    });
  } else {
    accountId = canonicalResolution.accountId;
    await insertAccountSource({
      accountId,
      sourceType: raw.engineType,
      sourceProvider: providerLabel,
      sourceExternalId: raw.sourceExternalId,
      sourceUrl: raw.sourceUrl,
      rawSnapshot: raw.rawPayload,
    });
  }

  const websiteRecoveryCounters = {
    accountsAttempted: 0,
    fetchFailed: 0,
    internalPagesFetched: 0,
    emailCandidatesFound: 0,
    contactPointsCreated: 0,
    verificationQueued: 0,
  };

  // --- WEBSITE ENRICHMENT ---
  if (accountFields.websiteUrl && incoming.normalizedDomain && options.enrichContacts !== false) {
    const cache = await getWebsiteEnrichmentStatus(accountId, incoming.normalizedDomain);
    const now = new Date();
    const transientCacheFailure = cache?.status === "timeout" || cache?.status === "transient_error";
    const transientRetryAt = transientCacheFailure && cache
      ? new Date(cache.startedAt.getTime() + 6 * 60 * 60 * 1000)
      : null;
    const transientBackoffElapsed = transientRetryAt !== null && transientRetryAt <= now;
    const needsRefresh = !cache || !cache.nextRefreshAt || cache.nextRefreshAt <= now || transientBackoffElapsed;

    if (needsRefresh) {
      websiteRecoveryCounters.accountsAttempted += 1;
      const service = new WebsiteEnrichmentService(cachedFetcher);
      const result = await service.enrich({
        workspaceId: campaign.workspaceId,
        accountId,
        websiteUrl: accountFields.websiteUrl,
      });
      if (result.status !== "completed" && result.status !== "no_website") {
        websiteRecoveryCounters.fetchFailed += 1;
      }
      websiteRecoveryCounters.internalPagesFetched += result.internalPagesFetched ?? 0;
      websiteRecoveryCounters.emailCandidatesFound += result.emailCandidatesFound ?? 0;

      const nextRefreshAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
      const failureBackoffMs = result.status === "timeout" || result.status === "transient_error"
        ? 6 * 60 * 60 * 1000
        : result.status === "dns_failure" || result.status === "http_error" || result.status === "parse_error"
          ? 30 * 24 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
      const failureRefreshAt = new Date(now.getTime() + failureBackoffMs);
      
      let finalNextRefreshAt: Date | undefined;
      if (result.status === "completed") {
        finalNextRefreshAt = nextRefreshAt;
      } else if (result.status === "blocked_unsafe_url" || result.status === "no_website") {
        finalNextRefreshAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year, basically permanent
      } else {
        finalNextRefreshAt = failureRefreshAt;
      }

      await upsertWebsiteEnrichmentStatus({
        workspaceId: campaign.workspaceId,
        accountId,
        normalizedDomain: incoming.normalizedDomain,
        status: result.status,
        startedAt: now,
        completedAt: new Date(),
        lastSuccessAt: result.status === "completed" ? new Date() : cache?.lastSuccessAt ?? undefined,
        contentHash: result.contentHash,
        pagesFetched: result.pagesFetched,
        error: result.errorDetails,
        nextRefreshAt: finalNextRefreshAt,
      });

      for (const fact of result.evidence) {
        await insertWebsiteEvidence({
          workspaceId: campaign.workspaceId,
          accountId,
          normalizedDomain: incoming.normalizedDomain!,
          sourceUrl: fact.sourceUrl,
          evidenceType: fact.evidenceType,
          value: fact.value,
          normalizedValue: fact.normalizedValue ?? fact.value,
          snippet: fact.snippet,
          contentHash: result.contentHash ?? "",
        });

        if (fact.evidenceType === "phone") {
          const phoneNorm = fact.normalizedValue ?? fact.value;
          // Note: duplicate checking for phones across the account should ideally happen here or rely on DB upsert logic.
          // For now we just insert it since contact points can have multiple.
          await insertContactPoint({
            workspaceId: campaign.workspaceId,
            accountId,
            type: "phone",
            value: fact.value,
            normalizedValue: phoneNorm,
            label: "Teléfono",
            isGeneric: true,
            isPersonalOrNamed: false,
            priorityScore: 0,
            verificationStatus: "unverified",
            verificationProvider: null,
            sourceUrl: fact.sourceUrl,
            sourceType: "website_enrichment",
          });
        }
      }
    }

    const unlinkedEmailEvidence = await listUnlinkedWebsiteEmailEvidence(accountId, incoming.normalizedDomain);
    for (const fact of unlinkedEmailEvidence) {
      const email = fact.normalizedValue.trim().toLowerCase();
      if (!email) continue;
      const contactPoint = await insertContactPointWithStatus({
        workspaceId: campaign.workspaceId,
        accountId,
        type: "email",
        value: fact.value,
        normalizedValue: email,
        label: email.split("@")[0] ?? "",
        isGeneric: true,
        isPersonalOrNamed: false,
        priorityScore: 0,
        verificationStatus: "unverified",
        verificationProvider: null,
        sourceUrl: fact.sourceUrl,
        sourceType: "website_enrichment",
      });
      if (contactPoint.created) websiteRecoveryCounters.contactPointsCreated += 1;
      if (contactPoint.id && (contactPoint.created || contactPoint.verificationStatus === "unverified")) {
        const verificationQueued = await enqueueVerificationJob({
          workspaceId: campaign.workspaceId,
          contactPointId: contactPoint.id,
          normalizedEmail: email,
          provider: getVerificationEnv().EMAIL_VERIFICATION_PROVIDER,
        });
        if (verificationQueued) websiteRecoveryCounters.verificationQueued += 1;
      }
    }

    if (Object.values(websiteRecoveryCounters).some((count) => count > 0)) {
      console.info("WEBSITE_EMAIL_RECOVERY", {
        WEBSITE_RECOVERY_ACCOUNTS_ATTEMPTED: websiteRecoveryCounters.accountsAttempted,
        WEBSITE_RECOVERY_FETCH_FAILED: websiteRecoveryCounters.fetchFailed,
        WEBSITE_RECOVERY_INTERNAL_PAGES_FETCHED: websiteRecoveryCounters.internalPagesFetched,
        WEBSITE_EMAIL_CANDIDATES_FOUND: websiteRecoveryCounters.emailCandidatesFound,
        WEBSITE_EMAIL_CONTACT_POINTS_CREATED: websiteRecoveryCounters.contactPointsCreated,
        WEBSITE_EMAIL_VERIFICATION_QUEUED: websiteRecoveryCounters.verificationQueued,
      });
    }
  }

  const serperEmailDiagnostics = {
    candidatesFound: processed.serperEmailRecovery.candidatesFound,
    candidatesRelevant: processed.serperEmailRecovery.candidatesRelevant,
    contactPointsCreated: 0,
    duplicatesSkipped: processed.serperEmailRecovery.duplicateCandidatesSkipped,
    verificationQueued: 0,
  };
  for (const contactPoint of processed.contactPoints) {
    const insertedContactPoint = await insertContactPointWithStatus({
      workspaceId: campaign.workspaceId,
      accountId,
      type: "email",
      value: contactPoint.email,
      normalizedValue: contactPoint.email.toLowerCase(),
      label: contactPoint.label,
      isGeneric: contactPoint.isGeneric,
      isPersonalOrNamed: !contactPoint.isGeneric,
      priorityScore: contactPoint.priorityScore,
      verificationStatus: contactPoint.verificationStatus,
      verificationProvider: contactPoint.verificationProvider,
      sourceUrl: contactPoint.sourceUrl,
      sourceType: contactPoint.sourceType === "serper_snippet" ? "serper_snippet" : raw.engineType,
    });
    if (contactPoint.sourceType === "serper_snippet") {
      if (insertedContactPoint.created) serperEmailDiagnostics.contactPointsCreated += 1;
      else serperEmailDiagnostics.duplicatesSkipped += 1;
    }
    if (options.enrichContacts !== false && insertedContactPoint.id && (insertedContactPoint.created || insertedContactPoint.verificationStatus === "unverified")) {
      const verificationQueued = await enqueueVerificationJob({
        workspaceId: campaign.workspaceId,
        contactPointId: insertedContactPoint.id,
        normalizedEmail: contactPoint.email.toLowerCase(),
        provider: getVerificationEnv().EMAIL_VERIFICATION_PROVIDER,
      });
      if (contactPoint.sourceType === "serper_snippet" && verificationQueued) {
        serperEmailDiagnostics.verificationQueued += 1;
      }
    }
  }

  if (serperEmailDiagnostics.candidatesFound > 0) {
    console.info("SERPER_EMAIL_RECOVERY", {
      SERPER_EMAIL_CANDIDATES_FOUND: serperEmailDiagnostics.candidatesFound,
      SERPER_EMAIL_CANDIDATES_RELEVANT: serperEmailDiagnostics.candidatesRelevant,
      SERPER_EMAIL_CONTACT_POINTS_CREATED: serperEmailDiagnostics.contactPointsCreated,
      SERPER_EMAIL_DUPLICATES_SKIPPED: serperEmailDiagnostics.duplicatesSkipped,
      SERPER_EMAIL_VERIFICATION_QUEUED: serperEmailDiagnostics.verificationQueued,
    });
  }

  const membership = resolveMembershipStage(processed);
  await upsertCampaignMembership({
    campaignId: campaign.id,
    accountId,
    stage: membership.stage,
    rejectionReason: membership.rejectionReason,
    readyAt: membership.stage === "ready" ? new Date() : null,
  });

  if (membership.stage === "qualified" || membership.stage === "ready") {
    // Dynamically import to avoid circular dependency issues if any
    const { ProspectContextBuilder } = await import("@/services/intelligence/prospect-context-builder");
    const { hashProspectContext } = await import("@/services/intelligence/types");
    const { enqueueIntelligenceJob } = await import("@/infrastructure/neon/repositories/intelligence-queue");
    
    const contextBuilder = new ProspectContextBuilder();
    const context = await contextBuilder.buildContext(campaign.id, accountId);
    
    if (context) {
      const inputHash = hashProspectContext(context);
      await enqueueIntelligenceJob({
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        accountId: accountId,
        idempotencyKey: inputHash,
      });
    }
  }

  await updateRawCandidateAccountId(raw.id, accountId);
  await markRawCandidateProcessed(raw.id);
  if (raw.engineType === "maps_deep" && payload.kind === "maps" && incoming.normalizedDomain) {
    await enqueueProcessingJob({
      campaignId: campaign.id,
      type: "maps_deep_owner_enrichment",
      payload: { rawCandidateId: raw.id },
      idempotencyKey: `maps_deep_owner:${raw.id}`,
    });
  }
}

export interface ProcessingRunnerResult {
  jobsClaimed: number;
}

/** One bounded batch of processing work: claim+execute up to `maxJobsPerTick` `processing_jobs` (claims are global across every workspace's campaigns). Called once per `/api/cron/process` invocation. */
export async function runProcessingCronTick(
  maxJobsPerTick: number,
  now: Date = new Date(),
  options: ProcessingRunnerOptions = {},
): Promise<ProcessingRunnerResult> {
  const workerId = `cron-process-${randomUUID()}`;
  const startedAt = performance.now();
  const timeBudgetMs = options.timeBudgetMs ?? PROCESSING_CRON_TIME_BUDGET_MS;
  const startAnotherJobBeforeMs = Math.max(
    0,
    timeBudgetMs - Math.min(PROCESSING_JOB_START_RESERVE_MS, timeBudgetMs / 2),
  );
  let jobsClaimed = 0;

  while (jobsClaimed < maxJobsPerTick && performance.now() - startedAt < startAnotherJobBeforeMs) {
    const [job] = await claimProcessingJobs<ProcessingJobPayload>({
      workerId,
      batchSize: 1,
      now,
      campaignId: options.campaignId,
      requireAutopilot: options.campaignId === undefined,
    });
    if (!job) break;

    if (performance.now() - startedAt >= startAnotherJobBeforeMs) {
      await deferProcessingJob({
        jobId: job.id,
        workerId,
        nextAttemptAt: now,
        reason: "Processing cron reached its job-start reserve before execution.",
      });
      break;
    }

    jobsClaimed += 1;
    try {
      await executeProcessingJob(job, options);
      await completeProcessingJob({ jobId: job.id, workerId, now });
      const raw = await getRawCandidateById(job.payload.rawCandidateId);
      if (raw?.searchSeedRunId) await refreshSearchSeedQualification(raw.searchSeedRunId);
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) {
        await deferProcessingJob({ jobId: job.id, workerId, nextAttemptAt: error.retryAt, reason: error.message });
      } else {
        await failProcessingJob({ workerId, job, error, now });
      }
      const raw = await getRawCandidateById(job.payload.rawCandidateId);
      if (raw?.searchSeedRunId) await refreshSearchSeedQualification(raw.searchSeedRunId);
    }
  }

  return { jobsClaimed };
}
