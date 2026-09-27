import { randomUUID } from "node:crypto";
import type { AccountStatus } from "@/domain/accounts/types";
import type { CampaignMembershipStage } from "@/domain/campaigns/types";
import { getCampaignById } from "@/infrastructure/neon/repositories/campaigns";
import { upsertCampaignMembership } from "@/infrastructure/neon/repositories/campaigns";
import {
  claimProcessingJobs,
  completeProcessingJob,
  failProcessingJob,
} from "@/infrastructure/neon/repositories/job-queue";
import { getRawCandidateById, markRawCandidateProcessed, refreshSearchSeedQualification, updateRawCandidateAccountId } from "@/infrastructure/neon/repositories/discovery";
import {
  findCandidateAccountMatches,
  getAccountById,
  insertAccount,
  insertAccountSource,
  insertContactPoint,
  updateAccountFields,
} from "@/infrastructure/neon/repositories/accounts";
import { createEmailVerificationProvider } from "@/infrastructure/providers/provider-factory";
import { createInMemoryVerificationCacheStore } from "@/services/verification/email-verification-cache";
import type { EmailVerificationProvider, WebsiteFetcher } from "@/domain/providers/types";
import { processRawCandidate, deriveIncomingIdentitySignals, type CandidateRawPayload, type ProcessedCandidateResult } from "@/services/discovery/candidate-processor";
import { mergeMissingAccountFields, type IncomingAccountFields } from "@/services/accounts/account-enrichment-merge";
import { realWebsiteFetcher, providerLabelForEngine } from "./engine-factory";
import { WebsiteEnrichmentService } from "@/services/enrichment/website-enrichment-service";
import { getWebsiteEnrichmentStatus, upsertWebsiteEnrichmentStatus, insertWebsiteEvidence } from "@/infrastructure/neon/repositories/enrichment";
import { DomainFetchCache } from "@/lib/security/safe-fetch";

interface ProcessingJobPayload {
  rawCandidateId: string;
}

export interface ProcessingRunnerOptions {
  enrichContacts?: boolean;
  campaignId?: string;
}

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
  if (processed.spainVerdict === "needs_review") return "needs_review";
  if (processed.readyForOutreach) return "contactable";
  return "no_contact_found";
}

function resolveMembershipStage(processed: ProcessedCandidateResult): { stage: CampaignMembershipStage; rejectionReason: string | null } {
  if (processed.readyForOutreach) return { stage: "ready", rejectionReason: null };
  if (processed.spainVerdict === "rejected") return { stage: "rejected", rejectionReason: processed.rejectionReason };
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
  job: { id: string; campaignId: string; payload: ProcessingJobPayload },
  options: ProcessingRunnerOptions,
): Promise<void> {
  const raw = await getRawCandidateById(job.payload.rawCandidateId);
  if (!raw || raw.rawPayload === undefined) throw new Error(`raw_candidate not found: ${job.payload.rawCandidateId}`);

  const campaign = await getCampaignById(job.campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${job.campaignId}`);

  const payload = raw.rawPayload as unknown as CandidateRawPayload;
  const incoming = deriveIncomingIdentitySignals(payload);
  const existingAccounts = await findCandidateAccountMatches(campaign.workspaceId, incoming);

  const fetchCache = new DomainFetchCache();
  const cachedFetcher = {
    fetchPage: async (url: string) => {
      const cached = fetchCache.get(url);
      if (cached) return cached;
      const res = await realWebsiteFetcher.fetchPage(url);
      fetchCache.set(url, res);
      return res;
    },
  };

  const processed = await processRawCandidate(payload, raw.engineType, {
    existingAccounts,
    websiteFetcher: options.enrichContacts === false ? smokeWebsiteFetcher : cachedFetcher,
    verificationProvider: options.enrichContacts === false ? smokeVerificationProvider : createEmailVerificationProvider(campaign.workspaceId),
    verificationCacheStore: createInMemoryVerificationCacheStore(),
    now: new Date(),
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

  let accountId: string;
  if (processed.isDuplicate && processed.matchedAccountKey) {
    accountId = processed.matchedAccountKey;
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
    accountId = await insertAccount({
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
    });
    await insertAccountSource({
      accountId,
      sourceType: raw.engineType,
      sourceProvider: providerLabel,
      sourceExternalId: raw.sourceExternalId,
      sourceUrl: raw.sourceUrl,
      rawSnapshot: raw.rawPayload,
    });
  }

  // --- WEBSITE ENRICHMENT ---
  if (accountFields.websiteUrl && incoming.normalizedDomain && options.enrichContacts !== false) {
    const cache = await getWebsiteEnrichmentStatus(accountId, incoming.normalizedDomain);
    const now = new Date();
    const needsRefresh = !cache || !cache.nextRefreshAt || cache.nextRefreshAt <= now;

    if (needsRefresh) {
      const service = new WebsiteEnrichmentService(cachedFetcher);
      const result = await service.enrich({
        workspaceId: campaign.workspaceId,
        accountId,
        websiteUrl: accountFields.websiteUrl,
      });

      const nextRefreshAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
      const failureRefreshAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day
      
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

        if (fact.evidenceType === "email") {
          const emailLower = fact.value.toLowerCase();
          if (!processed.contactPoints.some((cp) => cp.email.toLowerCase() === emailLower)) {
            await insertContactPoint({
              workspaceId: campaign.workspaceId,
              accountId,
              type: "email",
              value: fact.value,
              normalizedValue: emailLower,
              label: fact.value.split("@")[0] ?? "",
              isGeneric: fact.isGeneric ?? true, // use fact metadata
              isPersonalOrNamed: fact.isPersonalOrNamed ?? false, // use fact metadata
              priorityScore: 0,
              verificationStatus: "unverified",
              verificationProvider: null,
              sourceUrl: fact.sourceUrl,
              sourceType: "website_enrichment",
            });
          }
        }
        
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
  }

  for (const contactPoint of processed.contactPoints) {
    await insertContactPoint({
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
      sourceType: raw.engineType,
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
  let jobsClaimed = 0;

  const jobs = await claimProcessingJobs<ProcessingJobPayload>({
    workerId,
    batchSize: maxJobsPerTick,
    now,
    campaignId: options.campaignId,
    requireAutopilot: options.campaignId === undefined,
  });
  for (const job of jobs) {
    jobsClaimed += 1;
    try {
      await executeProcessingJob(job, options);
      await completeProcessingJob({ jobId: job.id, workerId, now });
      const raw = await getRawCandidateById(job.payload.rawCandidateId);
      if (raw?.searchSeedRunId) await refreshSearchSeedQualification(raw.searchSeedRunId);
    } catch (error) {
      await failProcessingJob({ workerId, job, error, now });
      const raw = await getRawCandidateById(job.payload.rawCandidateId);
      if (raw?.searchSeedRunId) await refreshSearchSeedQualification(raw.searchSeedRunId);
    }
  }

  return { jobsClaimed };
}
