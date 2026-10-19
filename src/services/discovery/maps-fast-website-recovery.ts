import type { MapsPlaceResult, SerpResult } from "@/domain/providers/types";
import { normalizeBusinessName, normalizeDomain, normalizePhoneES } from "@/lib/normalization";

const BLOCKED_WEBSITE_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "google.com",
  "google.es",
  "bing.com",
  "mapquest.com",
  "openstreetmap.org",
  "paginasamarillas.es",
  "11870.com",
  "yelp.com",
  "tripadvisor.com",
  "foursquare.com",
  "cylex.es",
  "einforma.com",
  "kompass.com",
  "amazon.es",
  "ebay.es",
  "wallapop.com",
] as const;

export interface RecoveredBusinessWebsite {
  domain: string;
  websiteUrl: string;
  evidence: SerpResult;
}

export type MapsFastWebsiteRecoveryOutcome =
  | { status: "blocked" }
  | { status: "failed" | "no_match" }
  | { status: "recovered"; website: RecoveredBusinessWebsite };

export function buildMapsFastWebsiteRecoveryQuery(place: MapsPlaceResult): string | null {
  const businessName = place.name.trim().replace(/["\\]/g, " ").replace(/\s+/g, " ");
  const normalizedName = normalizeBusinessName(businessName);
  if (normalizedName.length < 7 || normalizedName.split(" ").length < 2) return null;

  const localities = [place.city, place.province]
    .map((value) => value?.trim() ?? "")
    .filter((value, index, values) => value && values.findIndex((candidate) => normalizeBusinessName(candidate) === normalizeBusinessName(value)) === index);
  const phone = normalizePhoneES(place.phone);
  if (localities.length === 0 && !phone) return null;

  const qualifier = localities.length > 0 ? localities.join(" ") : phone;
  return `"${businessName}" ${qualifier}`;
}

function isBlockedWebsiteResult(result: SerpResult, domain: string): boolean {
  if (BLOCKED_WEBSITE_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) return true;
  if (/\/(?:maps?|places?|directory|directories|marketplace|search)(?:\/|$)/i.test(new URL(result.url).pathname)) return true;
  return /\b(?:directory|directorio|marketplace|marketplace|mapa|google maps)\b/i.test(`${result.title} ${result.snippet}`);
}

export function selectMapsFastRecoveredWebsite(
  place: MapsPlaceResult,
  results: readonly SerpResult[],
): RecoveredBusinessWebsite | null {
  const normalizedName = normalizeBusinessName(place.name);
  if (normalizedName.length < 7 || normalizedName.split(" ").length < 2) return null;

  const localities = [place.city, place.province]
    .map((value) => normalizeBusinessName(value))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const normalizedPhone = normalizePhoneES(place.phone)?.replace(/\D/g, "").slice(-9) ?? null;
  const candidates = results.flatMap((result) => {
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      return [];
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return [];

    const domainFromUrl = normalizeDomain(url.hostname);
    const domain = normalizeDomain(result.domain) ?? domainFromUrl;
    if (!domain || domain !== domainFromUrl || isBlockedWebsiteResult(result, domain)) return [];

    const normalizedTitle = normalizeBusinessName(result.title);
    const normalizedSnippet = normalizeBusinessName(result.snippet);
    const titleMatches = normalizedTitle.includes(normalizedName);
    const snippetMatches = normalizedSnippet.includes(normalizedName);
    if (!titleMatches && !snippetMatches) return [];

    const evidenceText = `${normalizedTitle} ${normalizedSnippet}`;
    const locationMatches = localities.some((locality) => evidenceText.includes(locality));
    const phoneMatches = normalizedPhone !== null && result.snippet.replace(/\D/g, "").includes(normalizedPhone);
    if ((localities.length > 0 || normalizedPhone !== null) && !locationMatches && !phoneMatches) return [];

    return [{
      domain,
      score: (titleMatches ? 4 : 2) + (locationMatches ? 3 : 0) + (phoneMatches ? 4 : 0),
      evidence: result,
    }];
  });

  const bestByDomain = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const current = bestByDomain.get(candidate.domain);
    if (!current || candidate.score > current.score) bestByDomain.set(candidate.domain, candidate);
  }
  const ranked = [...bestByDomain.values()].sort((left, right) => right.score - left.score);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score)) return null;

  const selected = ranked[0]!;
  return {
    domain: selected.domain,
    websiteUrl: `https://${selected.domain}/`,
    evidence: selected.evidence,
  };
}