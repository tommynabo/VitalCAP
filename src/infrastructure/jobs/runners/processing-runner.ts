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

  const processed = await processRawCandidate(payload, raw.engineType, {
    existingAccounts,
    websiteFetcher: options.enrichContacts === false ? smokeWebsiteFetcher : realWebsiteFetcher,
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

  await updateRawCandidateAccountId(raw.id, accountId);
  await markRawCandidateProcessed(raw.id);
  if (raw.searchSeedRunId) await refreshSearchSeedQualification(raw.searchSeedRunId);
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
    } catch (error) {
      await failProcessingJob({ workerId, job, error, now });
    }
  }

  return { jobsClaimed };
}
