import type { AccountDedupSignal } from "@/domain/accounts/types";

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
  const strongMatches: AccountDedupMatch[] = [];

  for (const candidate of existing) {
    if (incoming.googlePlaceId && candidate.googlePlaceId && incoming.googlePlaceId === candidate.googlePlaceId) {
      strongMatches.push({ accountId: candidate.accountId, signal: "google_place_id", confidence: STRONG_SIGNAL_CONFIDENCE.google_place_id! });
    }
    if (incoming.normalizedDomain && candidate.normalizedDomain && incoming.normalizedDomain === candidate.normalizedDomain) {
      strongMatches.push({ accountId: candidate.accountId, signal: "normalized_domain", confidence: STRONG_SIGNAL_CONFIDENCE.normalized_domain! });
    }
    if (incoming.normalizedPhone && candidate.normalizedPhone && incoming.normalizedPhone === candidate.normalizedPhone) {
      strongMatches.push({ accountId: candidate.accountId, signal: "normalized_phone", confidence: STRONG_SIGNAL_CONFIDENCE.normalized_phone! });
    }
  }

  if (strongMatches.length > 0) {
    return {
      action: "merge",
      matches: strongMatches,
      confidence: Math.max(...strongMatches.map((m) => m.confidence)),
    };
  }

  const fuzzyMatches: AccountDedupMatch[] = [];
  for (const candidate of existing) {
    if (!incoming.normalizedName || incoming.normalizedName !== candidate.normalizedName) continue;

    if (incoming.postalCode && candidate.postalCode && incoming.postalCode === candidate.postalCode) {
      fuzzyMatches.push({ accountId: candidate.accountId, signal: "name_postal_code", confidence: FUZZY_SIGNAL_CONFIDENCE.name_postal_code! });
    }
    if (incoming.normalizedAddress && candidate.normalizedAddress && incoming.normalizedAddress === candidate.normalizedAddress) {
      fuzzyMatches.push({ accountId: candidate.accountId, signal: "name_address", confidence: FUZZY_SIGNAL_CONFIDENCE.name_address! });
    }
    if (
      typeof incoming.latitude === "number" &&
      typeof incoming.longitude === "number" &&
      typeof candidate.latitude === "number" &&
      typeof candidate.longitude === "number" &&
      distanceMeters(
        { latitude: incoming.latitude, longitude: incoming.longitude },
        { latitude: candidate.latitude, longitude: candidate.longitude },
      ) <= opts.geoProximityMeters
    ) {
      fuzzyMatches.push({ accountId: candidate.accountId, signal: "name_geo_proximity", confidence: FUZZY_SIGNAL_CONFIDENCE.name_geo_proximity! });
    }
  }

  if (fuzzyMatches.length === 0) {
    return { action: "no_match", matches: [], confidence: 0 };
  }

  const bestConfidence = Math.max(...fuzzyMatches.map((m) => m.confidence));
  return {
    action: bestConfidence >= opts.fuzzyMergeThreshold ? "merge" : "flag_for_review",
    matches: fuzzyMatches,
    confidence: bestConfidence,
  };
}
