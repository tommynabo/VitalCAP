import type { EngineType } from "@/domain/campaigns/types";
import type { BusinessType } from "@/domain/accounts/types";
import type { RoleType, VerificationStatus } from "@/domain/contacts/types";
import type { MapsPlaceResult, SerpResult, WebsiteFetcher, EmailVerificationProvider } from "@/domain/providers/types";
import { normalizeBusinessName, normalizeDomain, normalizePhoneES } from "@/lib/normalization";
import { evaluateSpainEligibility, type SpainEligibilityVerdict } from "@/lib/geography/spain-eligibility";
import { evaluateAccountDedup, type AccountIdentitySignals } from "@/services/deduplication/account-dedup";
import { classifyBusinessType } from "./business-type";
import { extractCandidateEmails } from "@/services/enrichment/email-extraction";
import { computeStrategicPriority } from "@/services/routing/contact-priority";
import { isContactPointAcceptable, DEFAULT_VERIFICATION_ACCEPTANCE_POLICY, type VerificationAcceptancePolicy } from "@/services/verification/acceptance-policy";
import { verifyEmailsWithCache, type EmailVerificationCacheStore } from "@/services/verification/email-verification-cache";

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
}

export interface ProcessedCandidateResult {
  engineType: EngineType;
  accountKey: string;
  businessNameGuess: string;
  isDuplicate: boolean;
  matchedAccountKey: string | null;
  spainVerdict: SpainEligibilityVerdict;
  businessType: BusinessType;
  contactPoints: ProcessedContactPoint[];
  readyForOutreach: boolean;
  rejectionReason: string | null;
}

export interface ProcessingContext {
  /** Accounts already known this campaign, keyed the same way `accountKey` is derived, for global dedup. */
  existingAccounts: AccountIdentitySignals[];
  websiteFetcher: WebsiteFetcher;
  verificationProvider: EmailVerificationProvider;
  verificationCacheStore: EmailVerificationCacheStore;
  now: Date;
  verificationPolicy?: VerificationAcceptancePolicy;
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

function accountKeyFor(incoming: Omit<AccountIdentitySignals, "accountId">, businessNameGuess: string, geography: string): string {
  if (incoming.googlePlaceId) return `place:${incoming.googlePlaceId}`;
  if (incoming.normalizedDomain) return `domain:${incoming.normalizedDomain}`;
  if (incoming.normalizedPhone) return `phone:${incoming.normalizedPhone}`;
  return `name:${normalizeBusinessName(businessNameGuess)}|geo:${geography.toLowerCase()}`;
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
      contactPoints: [],
      readyForOutreach: false,
      rejectionReason: `Rejected: ${spainResult.reason}`,
    };
  }

  // Step: gather HTML for email extraction. maps_deep already crawled multiple pages during discovery;
  // every other engine does a single best-effort homepage fetch here (§2.3 step 6 / §2.9 "public contact point discovery").
  const pages: Array<{ url: string; body: string }> = [];
  if (payload.kind === "maps" && payload.crawledPages) {
    pages.push(...payload.crawledPages);
  } else if (websiteUrl) {
    try {
      const fetched = await context.websiteFetcher.fetchPage(websiteUrl);
      pages.push({ url: fetched.url, body: fetched.body });
    } catch {
      // A single unreachable/blocked website must not fail the whole candidate — it just yields zero contact points.
    }
  }

  const extractedEmails = pages.flatMap((page) => extractCandidateEmails(page.body, page.url));
  const uniqueEmails = Array.from(new Map(extractedEmails.map((e) => [e.email, e])).values());

  // Prompt 6 §6.1 Flow F (provider outage): a verification-provider failure
  // must never crash candidate processing or produce an invalid send — it
  // degrades to `unverified` (unacceptable under the default policy) so the
  // candidate is simply not marked ready, never lost and never guessed valid.
  let outcomes: Awaited<ReturnType<typeof verifyEmailsWithCache>>["outcomes"] = [];
  try {
    outcomes = (
      await verifyEmailsWithCache(context.verificationProvider, uniqueEmails.map((e) => e.email), context.verificationCacheStore, context.now)
    ).outcomes;
  } catch {
    outcomes = [];
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
    };
  });

  const hasAcceptableContact = contactPoints.some((cp) => cp.acceptable);
  const readyForOutreach = spainResult.verdict === "verified" && hasAcceptableContact && !isDuplicate;

  let rejectionReason: string | null = null;
  if (isDuplicate) rejectionReason = `Duplicate of existing account ${matchedAccountKey}`;
  else if (spainResult.verdict === "needs_review") rejectionReason = "Awaiting Spain eligibility review";
  else if (!hasAcceptableContact) rejectionReason = "No acceptable contact point found";

  return {
    engineType,
    accountKey,
    businessNameGuess,
    isDuplicate,
    matchedAccountKey,
    spainVerdict: spainResult.verdict,
    businessType,
    contactPoints,
    readyForOutreach,
    rejectionReason,
  };
}
