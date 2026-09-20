import { isKnownSpainProvinceName, isWithinSpainBoundingBox, provinceForPostalCode } from "./spain-provinces";

export type SpainEligibilityVerdict = "verified" | "rejected" | "needs_review";

export type SpainEligibilitySignal =
  | "provider_country_code_es"
  | "valid_es_postal_code"
  | "within_spain_bounding_box"
  | "phone_plus34"
  | "es_domain"
  | "known_province_or_city";

export interface SpainEligibilityInput {
  /** Country code as reported by the discovery provider, if any (e.g. "ES", "PT"). */
  providerCountryCode?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Raw (not yet normalized) phone as discovered. */
  phone?: string | null;
  websiteDomain?: string | null;
  province?: string | null;
  city?: string | null;
}

export interface SpainEligibilityResult {
  verdict: SpainEligibilityVerdict;
  matchedSignals: SpainEligibilitySignal[];
  reason: string;
}

/**
 * Evaluates the Spain-only hard boundary (Prompt 1 §1.4). Strong evidence
 * (provider country code, valid postal code, in-bounds coordinates) is
 * sufficient on its own to verify. A clear contradicting country code
 * rejects outright. Supporting-only evidence (phone/domain/province name)
 * is never enough by itself — it stays `needs_review` rather than being
 * silently accepted, same as no evidence at all.
 */
export function evaluateSpainEligibility(input: SpainEligibilityInput): SpainEligibilityResult {
  const matchedSignals: SpainEligibilitySignal[] = [];

  const providerCountryCode = input.providerCountryCode?.trim().toUpperCase() || null;
  if (providerCountryCode && providerCountryCode !== "ES") {
    return {
      verdict: "rejected",
      matchedSignals: [],
      reason: `Provider reported country code "${providerCountryCode}", not Spain.`,
    };
  }
  if (providerCountryCode === "ES") matchedSignals.push("provider_country_code_es");

  const province = provinceForPostalCode(input.postalCode);
  if (province) matchedSignals.push("valid_es_postal_code");

  if (
    typeof input.latitude === "number" &&
    typeof input.longitude === "number" &&
    isWithinSpainBoundingBox(input.latitude, input.longitude)
  ) {
    matchedSignals.push("within_spain_bounding_box");
  }

  const strongSignals = matchedSignals.filter((signal) => signal !== "known_province_or_city");
  if (strongSignals.length > 0) {
    return { verdict: "verified", matchedSignals, reason: "Strong Spain evidence present." };
  }

  // Supporting-only evidence from here — never sufficient alone.
  const supporting: SpainEligibilitySignal[] = [];
  if (input.phone?.replace(/[\s().-]/g, "").match(/^(\+34|0034)/)) supporting.push("phone_plus34");
  if (input.websiteDomain?.trim().toLowerCase().endsWith(".es")) supporting.push("es_domain");
  if (isKnownSpainProvinceName(input.province) || isKnownSpainProvinceName(input.city)) {
    supporting.push("known_province_or_city");
  }

  if (supporting.length > 0) {
    return {
      verdict: "needs_review",
      matchedSignals: supporting,
      reason: "Only supporting evidence found; needs more evidence before acceptance.",
    };
  }

  return { verdict: "needs_review", matchedSignals: [], reason: "No Spain evidence found." };
}
