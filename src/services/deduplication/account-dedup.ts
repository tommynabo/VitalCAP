import type { AccountDedupSignal } from "@/domain/accounts/types";
import { normalizeDomain } from "@/lib/normalization";

export interface AccountIdentitySignals {
  accountId: string;
  normalizedName: string;
  googlePlaceId?: string | null;
  normalizedDomain?: string | null;
  normalizedPhone?: string | null;
  postalCode?: string | null;
  normalizedAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AccountDedupMatch {
  accountId: string;
  signal: AccountDedupSignal;
  confidence: number;
}

export type AccountDedupAction = "merge" | "flag_for_review" | "no_match";

export interface AccountDedupDecision {
  action: AccountDedupAction;
  matches: AccountDedupMatch[];
  confidence: number;
}

export interface AccountDedupOptions {
  /** Fuzzy/composite matches at or above this confidence auto-merge; below it, they only flag for review. */
  fuzzyMergeThreshold: number;
  /** Max distance (meters) for the name+geo-proximity composite signal. */
  geoProximityMeters: number;
}

const NON_IDENTITY_DOMAIN_GROUPS = {
  socialPlatform: ["facebook.com", "instagram.com", "tiktok.com", "linkedin.com", "youtube.com", "linktr.ee"],
  siteBuilder: ["sites.google.com", "wixsite.com", "wordpress.com", "blogspot.com"],
  directory: ["google.com", "yelp.com", "tripadvisor.com", "paginasamarillas.es", "cylex.es", "infobel.com"],
} as const;

export type BusinessIdentityDomainClass = keyof typeof NON_IDENTITY_DOMAIN_GROUPS | "first_party_candidate";

export function classifyBusinessIdentityDomain(domain: string | null | undefined): BusinessIdentityDomainClass | null {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  for (const [classification, roots] of Object.entries(NON_IDENTITY_DOMAIN_GROUPS) as Array<[BusinessIdentityDomainClass, readonly string[]]>) {
    if (roots.some((root) => normalized === root || normalized.endsWith(`.${root}`))) return classification;
  }
  return "first_party_candidate";
}

export function businessIdentityDomain(domain: string | null | undefined): string | null {
  return classifyBusinessIdentityDomain(domain) === "first_party_candidate" ? normalizeDomain(domain) : null;
}

const DEFAULT_OPTIONS: AccountDedupOptions = {
  fuzzyMergeThreshold: 0.8,
  geoProximityMeters: 150,
};

const STRONG_SIGNAL_CONFIDENCE: Record<string, number> = {
  google_place_id: 1,
  normalized_domain: 0.98,
  normalized_phone: 0.95,
};

const FUZZY_SIGNAL_CONFIDENCE: Record<string, number> = {
  name_postal_code: 0.8,
  name_address: 0.85,
  name_geo_proximity: 0.7,
};

/** Haversine distance in meters between two lat/long points. */
function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Evaluates whether `incoming` matches any `existing` account (Prompt 1
 * §1.2). Strong signals (Place ID / domain / phone) always win outright.
 * Composite/fuzzy signals only merge automatically at/above
 * `fuzzyMergeThreshold`; below that, they are flagged for human review —
 * never silently merged. Every match records the exact signal + confidence
 * for the `AccountMergeRecord` audit trail.
 */
export function evaluateAccountDedup(
  incoming: Omit<AccountIdentitySignals, "accountId">,
  existing: readonly AccountIdentitySignals[],
  options: Partial<AccountDedupOptions> = {},
): AccountDedupDecision {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const identityDomain = businessIdentityDomain(incoming.normalizedDomain);
  const placeMatches = incoming.googlePlaceId
    ? existing.filter((candidate) => candidate.googlePlaceId === incoming.googlePlaceId)
    : [];
  if (placeMatches.length > 0) {
    const matches = placeMatches.map((candidate) => ({
      accountId: candidate.accountId,
      signal: "google_place_id" as const,
      confidence: STRONG_SIGNAL_CONFIDENCE.google_place_id!,
    }));
    return { action: matches.length === 1 ? "merge" : "flag_for_review", matches, confidence: STRONG_SIGNAL_CONFIDENCE.google_place_id! };
  }

  const domainMatches = identityDomain
    ? existing.filter((candidate) => businessIdentityDomain(candidate.normalizedDomain) === identityDomain)
    : [];
  const phoneMatches = incoming.normalizedPhone
    ? existing.filter((candidate) => candidate.normalizedPhone === incoming.normalizedPhone)
    : [];
  const sameName = existing.filter((candidate) => incoming.normalizedName && incoming.normalizedName === candidate.normalizedName);
  const nameAddressMatches = sameName.filter((candidate) => incoming.normalizedAddress && incoming.normalizedAddress === candidate.normalizedAddress);
  const namePostalMatches = sameName.filter((candidate) => incoming.postalCode && incoming.postalCode === candidate.postalCode);
  const nameGeoMatches = sameName.filter((candidate) =>
    typeof incoming.latitude === "number" && typeof incoming.longitude === "number"
    && typeof candidate.latitude === "number" && typeof candidate.longitude === "number"
    && distanceMeters(
      { latitude: incoming.latitude, longitude: incoming.longitude },
      { latitude: candidate.latitude, longitude: candidate.longitude },
    ) <= opts.geoProximityMeters,
  );

  const placeIdConflicts = existing.filter((candidate) =>
    Boolean(incoming.googlePlaceId && candidate.googlePlaceId && incoming.googlePlaceId !== candidate.googlePlaceId)
    && (domainMatches.includes(candidate) || phoneMatches.includes(candidate)
      || nameAddressMatches.includes(candidate) || namePostalMatches.includes(candidate) || nameGeoMatches.includes(candidate)),
  );
  if (placeIdConflicts.length > 0) {
    const matches: AccountDedupMatch[] = placeIdConflicts.map((candidate) => {
      const signal: AccountDedupSignal = domainMatches.includes(candidate) ? "normalized_domain"
        : phoneMatches.includes(candidate) ? "normalized_phone"
          : nameAddressMatches.includes(candidate) ? "name_address"
            : namePostalMatches.includes(candidate) ? "name_postal_code" : "name_geo_proximity";
      const confidence = domainMatches.includes(candidate) ? STRONG_SIGNAL_CONFIDENCE.normalized_domain!
        : phoneMatches.includes(candidate) ? STRONG_SIGNAL_CONFIDENCE.normalized_phone!
          : nameAddressMatches.includes(candidate) ? FUZZY_SIGNAL_CONFIDENCE.name_address!
            : namePostalMatches.includes(candidate) ? FUZZY_SIGNAL_CONFIDENCE.name_postal_code! : FUZZY_SIGNAL_CONFIDENCE.name_geo_proximity!;
      return { accountId: candidate.accountId, signal, confidence };
    });
    return { action: "flag_for_review", matches, confidence: Math.max(...matches.map((match) => match.confidence)) };
  }

  if (domainMatches.length > 0) {
    const matches = domainMatches.map((candidate) => ({
      accountId: candidate.accountId,
      signal: "normalized_domain" as const,
      confidence: STRONG_SIGNAL_CONFIDENCE.normalized_domain!,
    }));
    return { action: matches.length === 1 ? "merge" : "flag_for_review", matches, confidence: STRONG_SIGNAL_CONFIDENCE.normalized_domain! };
  }

  if (phoneMatches.length > 0) {
    const matches = phoneMatches.map((candidate) => ({
      accountId: candidate.accountId,
      signal: "normalized_phone" as const,
      confidence: STRONG_SIGNAL_CONFIDENCE.normalized_phone!,
    }));
    return { action: matches.length === 1 ? "merge" : "flag_for_review", matches, confidence: STRONG_SIGNAL_CONFIDENCE.normalized_phone! };
  }

  const compositeSignals: Array<{ signal: AccountDedupSignal; confidence: number; matches: AccountDedupMatch[] }> = [
    {
      signal: "name_address",
      confidence: FUZZY_SIGNAL_CONFIDENCE.name_address!,
      matches: nameAddressMatches
        .map((candidate) => ({ accountId: candidate.accountId, signal: "name_address", confidence: FUZZY_SIGNAL_CONFIDENCE.name_address! })),
    },
    {
      signal: "name_postal_code",
      confidence: FUZZY_SIGNAL_CONFIDENCE.name_postal_code!,
      matches: namePostalMatches
        .map((candidate) => ({ accountId: candidate.accountId, signal: "name_postal_code", confidence: FUZZY_SIGNAL_CONFIDENCE.name_postal_code! })),
    },
    {
      signal: "name_geo_proximity",
      confidence: FUZZY_SIGNAL_CONFIDENCE.name_geo_proximity!,
      matches: nameGeoMatches
        .map((candidate) => ({ accountId: candidate.accountId, signal: "name_geo_proximity", confidence: FUZZY_SIGNAL_CONFIDENCE.name_geo_proximity! })),
    },
  ];

  for (const composite of compositeSignals) {
    if (composite.matches.length === 0) continue;
    const canAutoMerge = composite.signal !== "name_geo_proximity"
      && composite.matches.length === 1
      && composite.confidence >= opts.fuzzyMergeThreshold;
    return {
      action: canAutoMerge ? "merge" : "flag_for_review",
      matches: composite.matches,
      confidence: composite.confidence,
    };
  }

  return { action: "no_match", matches: [], confidence: 0 };
}
