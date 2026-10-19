import type { EngineType } from "@/domain/campaigns/types";
import type { BusinessType } from "@/domain/accounts/types";
import type { RoleType, VerificationStatus } from "@/domain/contacts/types";
import type { CandidateProcessingMetrics } from "@/domain/discovery/types";
import type { MapsPlaceResult, SerpResult, WebsiteFetcher, EmailVerificationProvider } from "@/domain/providers/types";
import { normalizeAddress, normalizeBusinessName, normalizeDomain, normalizePhoneES } from "@/lib/normalization";
import { evaluateSpainEligibility, type SpainEligibilityVerdict } from "@/lib/geography/spain-eligibility";
import { evaluateAccountDedup, type AccountIdentitySignals } from "@/services/deduplication/account-dedup";
import { classifyBusinessType, isAcceptedIcpBusinessType } from "./business-type";
import { extractCandidateEmailsWithDiagnostics } from "@/services/enrichment/email-extraction";
import { computeStrategicPriority } from "@/services/routing/contact-priority";
import { isContactPointAcceptable, DEFAULT_VERIFICATION_ACCEPTANCE_POLICY, type VerificationAcceptancePolicy } from "@/services/verification/acceptance-policy";
import { verifyEmailsWithCache, type EmailVerificationCacheStore } from "@/services/verification/email-verification-cache";
import type { MapsFastWebsiteRecoveryOutcome, RecoveredBusinessWebsite } from "./maps-fast-website-recovery";

/**
 * Shared candidate-processing pipeline (Prompt 2 §2.3 steps 1–11, reused by
 * §2.4/§2.8/§2.9's own discovery-specific steps). A `RawCandidate` produced
 * by any of the five engines is processed the same way from here on:
 * Spain check → dedup → business-type classification → contact-point
 * discovery/verification → ready evaluation. Engine-specific differences
 * (single-page fetch vs. multi-page crawl, no email-guessing for LinkedIn)
 * are expressed entirely through the raw payload each engine attaches, not
 * through a fork in this pipeline.
 */

export interface MapsRawPayload {
  kind: "maps";
  place: MapsPlaceResult;
  /** Present only for `maps_deep` — pages already crawled during discovery. */
  crawledPages?: Array<{ url: string; body: string }>;
  /** Present only for `maps_deep` — public evidence of a named owner/titular, never a guess. */
  ownerSerpEvidence?: SerpResult[];
}

export interface SerpRawPayload {
  kind: "serp";
  result: SerpResult;
  geography: string;
}

export interface LinkedInRawPayload {
  kind: "linkedin";
  profile: SerpResult;
  resolvedEmployerDomain: string | null;
  geography: string;
}

export type CandidateRawPayload = MapsRawPayload | SerpRawPayload | LinkedInRawPayload;

export interface ProcessedContactPoint {
  email: string;
  label: string;
  isGeneric: boolean;
  roleType: RoleType;
  priorityScore: number;
  verificationStatus: VerificationStatus;
  acceptable: boolean;
  sourceUrl: string;
  sourceType: "website" | "serper_snippet";
  verificationProvider: string | null;
}

export interface SerperEmailRecoveryDiagnostics {
  candidatesFound: number;
  candidatesRelevant: number;
  duplicateCandidatesSkipped: number;
}

export interface ProcessedCandidateResult {
  engineType: EngineType;
  accountKey: string;
  businessNameGuess: string;
  isDuplicate: boolean;
  matchedAccountKey: string | null;
  spainVerdict: SpainEligibilityVerdict;
  businessType: BusinessType;
  icpQualified: boolean;
  contactPoints: ProcessedContactPoint[];
  processingMetrics: CandidateProcessingMetrics;
  serperEmailRecovery: SerperEmailRecoveryDiagnostics;
  readyForOutreach: boolean;
  rejectionReason: string | null;
  recoveredWebsite?: RecoveredBusinessWebsite | null;
}

export interface ProcessingContext {
  /** Accounts already known this campaign, keyed the same way `accountKey` is derived, for global dedup. */
  existingAccounts: AccountIdentitySignals[];
  websiteFetcher: WebsiteFetcher;
  signal?: AbortSignal;
  verificationProvider: EmailVerificationProvider;
  verificationCacheStore: EmailVerificationCacheStore;
  now: Date;
  existingProcessingMetrics?: CandidateProcessingMetrics | null;
  recoverMapsFastWebsite?: (place: MapsPlaceResult) => Promise<MapsFastWebsiteRecoveryOutcome>;
  verificationPolicy?: VerificationAcceptancePolicy;
  deferVerification?: boolean;
  /** Default off (§2.9) — LinkedIn never guesses a personal email pattern unless a campaign explicitly opts in, and even then this pipeline still only reports it, never invents a source. */
  allowExperimentalEmailGuessing?: boolean;
}

const PURCHASING_LABELS = new Set(["compras", "purchasing", "pedidos"]);
const MANAGEMENT_LABELS = new Set(["gerencia", "direccion", "administracion"]);

function inferRoleType(label: string, isGeneric: boolean, context: string): RoleType {
  if (!isGeneric) {
    if (/titular|propietari|due[ñn]/i.test(context)) return "titular_pharmacist";
    if (/gerente|director/i.test(context)) return "manager";
    return "unknown";
  }
  if (PURCHASING_LABELS.has(label)) return "purchasing_manager";
  if (MANAGEMENT_LABELS.has(label)) return "manager";
  return "generic_role";
}

function identitySignalsFor(payload: CandidateRawPayload): {
  incoming: Omit<AccountIdentitySignals, "accountId">;
  spainInput: Parameters<typeof evaluateSpainEligibility>[0];
  businessNameGuess: string;
  categoryText: string;
  websiteUrl: string | null;
} {
  if (payload.kind === "maps") {
    const place = payload.place;
    const normalizedDomain = normalizeDomain(place.websiteUrl);
    return {
      incoming: {
        normalizedName: normalizeBusinessName(place.name),
        googlePlaceId: place.externalPlaceId,
        normalizedDomain,
        normalizedPhone: normalizePhoneES(place.phone),
        postalCode: place.postalCode,
        normalizedAddress: normalizeAddress(place.address) || null,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      spainInput: {
        providerCountryCode: place.countryCode,
        postalCode: place.postalCode,
        latitude: place.latitude,
        longitude: place.longitude,
        phone: place.phone,
        websiteDomain: normalizedDomain,
        province: place.province,
        city: place.city,
      },
      businessNameGuess: place.name,
      categoryText: place.category ?? place.name,
      websiteUrl: place.websiteUrl,
    };
  }

  if (payload.kind === "serp") {
    const normalizedDomain = normalizeDomain(payload.result.domain);
    return {
      incoming: {
        normalizedName: normalizeBusinessName(payload.result.title),
        normalizedDomain,
      },
      spainInput: {
        websiteDomain: normalizedDomain,
        province: payload.geography,
      },
      businessNameGuess: payload.result.title,
      categoryText: `${payload.result.title} ${payload.result.snippet}`,
      websiteUrl: payload.result.domain ? `https://${payload.result.domain}/` : null,
    };
  }

  const normalizedDomain = normalizeDomain(payload.resolvedEmployerDomain);
  return {
    incoming: {
      normalizedName: normalizeBusinessName(payload.profile.title),
      normalizedDomain,
    },
    spainInput: {
      websiteDomain: normalizedDomain,
      province: payload.geography,
    },
    businessNameGuess: payload.profile.title,
    categoryText: `${payload.profile.title} ${payload.profile.snippet}`,
    websiteUrl: payload.resolvedEmployerDomain ? `https://${payload.resolvedEmployerDomain}/` : null,
  };
}

/**
 * Exposes `identitySignalsFor`'s `incoming` half only — needed by the Neon
 * repository layer (Gate E) to run its bounded, indexed
 * `findCandidateAccountMatches` query *before* calling `processRawCandidate`
 * itself (which needs that query's result as its `existingAccounts` input).
 * Deliberately not exposing the rest of `identitySignalsFor`'s return value
 * — the Spain-eligibility/business-name/website-url fields are only ever
 * needed inside this module's own pipeline.
 */
export function deriveIncomingIdentitySignals(payload: CandidateRawPayload): Omit<AccountIdentitySignals, "accountId"> {
  return identitySignalsFor(payload).incoming;
}

export function hasLinkedInEmployerAccount(
  payload: CandidateRawPayload,
  existingAccounts: readonly AccountIdentitySignals[],
): boolean {
  if (payload.kind !== "linkedin") return true;
  const employerDomain = normalizeDomain(payload.resolvedEmployerDomain);
  return Boolean(employerDomain && existingAccounts.some((account) => account.normalizedDomain === employerDomain));
}

function accountKeyFor(incoming: Omit<AccountIdentitySignals, "accountId">, businessNameGuess: string, geography: string): string {
  if (incoming.googlePlaceId) return `place:${incoming.googlePlaceId}`;
  if (incoming.normalizedDomain) return `domain:${incoming.normalizedDomain}`;
  if (incoming.normalizedPhone) return `phone:${incoming.normalizedPhone}`;
  return `name:${normalizeBusinessName(businessNameGuess)}|geo:${geography.toLowerCase()}`;
}

function isRelevantSerperEmail(
  email: string,
  payload: SerpRawPayload,
  accountDomain: string | null | undefined,
): boolean {
  if (!accountDomain) return false;
  const emailDomain = normalizeDomain(email.split("@")[1]);
  if (emailDomain === accountDomain) return true;

  const sourceDomain = normalizeDomain(payload.result.domain) ?? normalizeDomain(payload.result.url);
  const normalizedTitle = normalizeBusinessName(payload.result.title);
  const normalizedSnippet = normalizeBusinessName(payload.result.snippet);
  return sourceDomain === accountDomain
    && normalizedTitle.length >= 8
    && normalizedSnippet.includes(normalizedTitle);
}

export async function processRawCandidate(
  payload: CandidateRawPayload,
  engineType: EngineType,
  context: ProcessingContext,
): Promise<ProcessedCandidateResult> {
  const policy = context.verificationPolicy ?? DEFAULT_VERIFICATION_ACCEPTANCE_POLICY;
  const { incoming, spainInput, businessNameGuess, categoryText, websiteUrl } = identitySignalsFor(payload);
  const geography = payload.kind === "maps" ? payload.place.province ?? payload.place.city ?? "" : payload.geography;
  const accountKey = accountKeyFor(incoming, businessNameGuess, geography);

  const dedupDecision = evaluateAccountDedup(incoming, context.existingAccounts);
  const isDuplicate = dedupDecision.action === "merge";
  const matchedAccountKey = isDuplicate ? dedupDecision.matches[0]?.accountId ?? null : null;

  const spainResult = evaluateSpainEligibility(spainInput);
  const businessType = classifyBusinessType(categoryText);

  if (spainResult.verdict === "rejected") {
    return {
      engineType,
      accountKey,
      businessNameGuess,
      isDuplicate,
      matchedAccountKey,
      spainVerdict: spainResult.verdict,
      businessType,
      icpQualified: false,
      contactPoints: [],
      processingMetrics: {
        homepageFetchAttempted: 0,
        homepageFetchSucceeded: 0,
        homepageFetchFailed: 0,
        emailRejectedFormat: 0,
        emailDuplicate: 0,
        websiteRecoveryAttempted: 0,
        websiteRecoverySucceeded: 0,
        websiteRecoveryFailed: 0,
        websiteRecoveryProvider: null,
      },
      serperEmailRecovery: { candidatesFound: 0, candidatesRelevant: 0, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: `Rejected: ${spainResult.reason}`,
    };
  }

  // Keep non-ICP discoveries auditable, but never spend enrichment or
  // verification capacity on them and never allow them into qualification.
  if (!isAcceptedIcpBusinessType(businessType)) {
    return {
      engineType,
      accountKey,
      businessNameGuess,
      isDuplicate,
      matchedAccountKey,
      spainVerdict: spainResult.verdict,
      businessType,
      icpQualified: false,
      contactPoints: [],
      processingMetrics: {
        homepageFetchAttempted: 0,
        homepageFetchSucceeded: 0,
        homepageFetchFailed: 0,
        emailRejectedFormat: 0,
        emailDuplicate: 0,
        websiteRecoveryAttempted: 0,
        websiteRecoverySucceeded: 0,
        websiteRecoveryFailed: 0,
        websiteRecoveryProvider: null,
      },
      serperEmailRecovery: { candidatesFound: 0, candidatesRelevant: 0, duplicateCandidatesSkipped: 0 },
      readyForOutreach: false,
      rejectionReason: `Rejected ICP: ${businessType} is outside the pharmacy, parapharmacy, and herbal-shop scope`,
    };
  }

  // Step: gather HTML for email extraction. maps_deep already crawled multiple pages during discovery;
  // every other engine does a single best-effort homepage fetch here (§2.3 step 6 / §2.9 "public contact point discovery").
  const pages: Array<{ url: string; body: string }> = [];
  let effectiveWebsiteUrl = websiteUrl;
  let recoveredWebsite: RecoveredBusinessWebsite | null = null;
  const processingMetrics: CandidateProcessingMetrics = {
    homepageFetchAttempted: 0,
    homepageFetchSucceeded: 0,
    homepageFetchFailed: 0,
    emailRejectedFormat: 0,
    emailDuplicate: 0,
    websiteRecoveryAttempted: context.existingProcessingMetrics?.websiteRecoveryAttempted ?? 0,
    websiteRecoverySucceeded: context.existingProcessingMetrics?.websiteRecoverySucceeded ?? 0,
    websiteRecoveryFailed: context.existingProcessingMetrics?.websiteRecoveryFailed ?? 0,
    websiteRecoveryProvider: context.existingProcessingMetrics?.websiteRecoveryProvider ?? null,
    websiteRecoveryStatus: context.existingProcessingMetrics?.websiteRecoveryStatus,
    websiteRecoveryDomain: context.existingProcessingMetrics?.websiteRecoveryDomain ?? null,
    websiteRecoveryUrl: context.existingProcessingMetrics?.websiteRecoveryUrl ?? null,
    websiteRecoveryEvidence: context.existingProcessingMetrics?.websiteRecoveryEvidence ?? null,
  };
  if (
    processingMetrics.websiteRecoveryStatus === "succeeded"
    && processingMetrics.websiteRecoveryDomain
    && processingMetrics.websiteRecoveryUrl
    && processingMetrics.websiteRecoveryEvidence
  ) {
    recoveredWebsite = {
      domain: processingMetrics.websiteRecoveryDomain,
      websiteUrl: processingMetrics.websiteRecoveryUrl,
      evidence: processingMetrics.websiteRecoveryEvidence,
    };
    effectiveWebsiteUrl = recoveredWebsite.websiteUrl;
  }
  const matchedAccount = matchedAccountKey
    ? context.existingAccounts.find((account) => account.accountId === matchedAccountKey)
    : undefined;
  const recoveryAlreadyFinalized = processingMetrics.websiteRecoveryStatus === "started"
    || processingMetrics.websiteRecoveryStatus === "succeeded"
    || processingMetrics.websiteRecoveryStatus === "failed";
  if (
    engineType === "maps_fast"
    && payload.kind === "maps"
    && !normalizeDomain(websiteUrl)
    && !normalizeDomain(matchedAccount?.normalizedDomain)
    && !recoveryAlreadyFinalized
    && context.recoverMapsFastWebsite
  ) {
    try {
      const recovery = await context.recoverMapsFastWebsite(payload.place);
      if (recovery.status === "recovered") {
        recoveredWebsite = recovery.website;
        effectiveWebsiteUrl = recovery.website.websiteUrl;
        processingMetrics.websiteRecoveryAttempted = 1;
        processingMetrics.websiteRecoverySucceeded = 1;
        processingMetrics.websiteRecoveryFailed = 0;
        processingMetrics.websiteRecoveryProvider = "serper";
        processingMetrics.websiteRecoveryStatus = "succeeded";
        processingMetrics.websiteRecoveryDomain = recovery.website.domain;
        processingMetrics.websiteRecoveryUrl = recovery.website.websiteUrl;
        processingMetrics.websiteRecoveryEvidence = recovery.website.evidence;
      } else if (recovery.status === "failed" || recovery.status === "no_match") {
        processingMetrics.websiteRecoveryAttempted = 1;
        processingMetrics.websiteRecoverySucceeded = 0;
        processingMetrics.websiteRecoveryFailed = 1;
        processingMetrics.websiteRecoveryProvider = "serper";
        processingMetrics.websiteRecoveryStatus = "failed";
      } else {
        processingMetrics.websiteRecoveryAttempted = 0;
        processingMetrics.websiteRecoverySucceeded = 0;
        processingMetrics.websiteRecoveryFailed = 0;
        processingMetrics.websiteRecoveryProvider = null;
        processingMetrics.websiteRecoveryStatus = "blocked";
      }
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
      processingMetrics.websiteRecoveryAttempted = 1;
      processingMetrics.websiteRecoverySucceeded = 0;
      processingMetrics.websiteRecoveryFailed = 1;
      processingMetrics.websiteRecoveryProvider = "serper";
      processingMetrics.websiteRecoveryStatus = "failed";
    }
  }
  if (payload.kind === "maps" && payload.crawledPages) {
    pages.push(...payload.crawledPages);
  } else if (effectiveWebsiteUrl) {
    processingMetrics.homepageFetchAttempted = 1;
    try {
      const fetched = await context.websiteFetcher.fetchPage(effectiveWebsiteUrl, { signal: context.signal });
      pages.push({ url: fetched.url, body: fetched.body });
      processingMetrics.homepageFetchSucceeded = 1;
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
      processingMetrics.homepageFetchFailed = 1;
      // A single unreachable/blocked website must not fail the whole candidate — it just yields zero contact points.
    }
  }

  const pageExtractionResults = pages.map((page) =>
    extractCandidateEmailsWithDiagnostics(page.body, page.url, "website", { allowEncodedAndObfuscated: true }),
  );
  const extractedEmails = pageExtractionResults.flatMap((result) => result.emails);
  processingMetrics.emailRejectedFormat += pageExtractionResults.reduce((total, result) => total + result.rejectedFormat, 0);
  processingMetrics.emailDuplicate += pageExtractionResults.reduce((total, result) => total + result.duplicates, 0);
  processingMetrics.websiteEmailExtractionLiteralFound = pageExtractionResults.reduce((total, result) => total + result.literalFound, 0);
  processingMetrics.websiteEmailExtractionDeobfuscatedFound = pageExtractionResults.reduce((total, result) => total + result.deobfuscatedFound, 0);
  const serperEmailRecovery: SerperEmailRecoveryDiagnostics = {
    candidatesFound: 0,
    candidatesRelevant: 0,
    duplicateCandidatesSkipped: 0,
  };
  if (payload.kind === "serp") {
    const extraction = extractCandidateEmailsWithDiagnostics(payload.result.snippet, payload.result.url, "serper_snippet");
    const candidates = extraction.emails;
    processingMetrics.emailRejectedFormat += extraction.rejectedFormat;
    processingMetrics.emailDuplicate += extraction.duplicates;
    serperEmailRecovery.candidatesFound = candidates.length;
    const websiteEmails = new Set(extractedEmails.map((candidate) => candidate.email));
    for (const candidate of candidates) {
      if (!isRelevantSerperEmail(candidate.email, payload, incoming.normalizedDomain)) continue;
      serperEmailRecovery.candidatesRelevant += 1;
      if (websiteEmails.has(candidate.email)) {
        serperEmailRecovery.duplicateCandidatesSkipped += 1;
        processingMetrics.emailDuplicate += 1;
        continue;
      }
      extractedEmails.push(candidate);
    }
  }
  const uniqueEmails = Array.from(new Map(extractedEmails.map((e) => [e.email, e])).values());
  processingMetrics.emailDuplicate += extractedEmails.length - uniqueEmails.length;

  // Prompt 6 §6.1 Flow F (provider outage): a verification-provider failure
  // must never crash candidate processing or produce an invalid send — it
  // degrades to `unverified` (unacceptable under the default policy) so the
  // candidate is simply not marked ready, never lost and never guessed valid.
  let outcomes: Awaited<ReturnType<typeof verifyEmailsWithCache>>["outcomes"] = [];
  if (!context.deferVerification) {
    try {
      outcomes = (
        await verifyEmailsWithCache(context.verificationProvider, uniqueEmails.map((e) => e.email), context.verificationCacheStore, context.now)
      ).outcomes;
    } catch {
      outcomes = [];
    }
  }
  const verificationByEmail = new Map(outcomes.map((o) => [o.email, o]));

  const contactPoints: ProcessedContactPoint[] = uniqueEmails.map((extracted) => {
    const verification = verificationByEmail.get(extracted.email);
    const roleType = inferRoleType(extracted.label, extracted.isGeneric, extracted.context);
    const { strategicPriority } = computeStrategicPriority({
      roleType,
      isPersonalOrNamed: !extracted.isGeneric,
      isGeneric: extracted.isGeneric,
      label: extracted.label,
    });
    const verificationStatus: VerificationStatus = verification?.code ?? "unverified";
    return {
      email: extracted.email,
      label: extracted.label,
      isGeneric: extracted.isGeneric,
      roleType,
      priorityScore: strategicPriority,
      verificationStatus,
      acceptable: isContactPointAcceptable(verificationStatus, policy),
      sourceUrl: extracted.sourceUrl,
      sourceType: extracted.sourceType,
      verificationProvider: verification ? context.verificationProvider.providerName : null,
    };
  });

  const hasAcceptableContact = contactPoints.some((cp) => cp.acceptable);
  const verificationEnabled = context.verificationProvider.providerName !== "disabled" && context.verificationProvider.providerName !== "disabled-smoke";
  const readyForOutreach = verificationEnabled && spainResult.verdict === "verified" && hasAcceptableContact;

  let rejectionReason: string | null = null;
  if (spainResult.verdict === "needs_review") rejectionReason = "Awaiting Spain eligibility review";
  else if (!hasAcceptableContact) {
    if (contactPoints.length === 0) rejectionReason = "no_email";
    else if (contactPoints.every((cp) => cp.verificationStatus === "unverified" || cp.verificationStatus === "unknown")) rejectionReason = "unverified";
    else if (contactPoints.every((cp) => cp.verificationStatus === "invalid" || cp.verificationStatus === "disposable" || cp.verificationStatus === "bounced")) rejectionReason = "invalid";
    else rejectionReason = "risky";
  }

  return {
    engineType,
    accountKey,
    businessNameGuess,
    isDuplicate,
    matchedAccountKey,
    spainVerdict: spainResult.verdict,
    businessType,
    icpQualified: true,
    contactPoints,
    processingMetrics,
    serperEmailRecovery,
    readyForOutreach,
    rejectionReason,
    recoveredWebsite,
  };
}
