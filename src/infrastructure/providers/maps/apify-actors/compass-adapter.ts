import type { MapsPlaceResult, MapsSearchInput } from "@/domain/providers/types";

export const COMPASS_ACTOR_ID = "compass/crawler-google-places";

export function buildCompassActorInput(input: MapsSearchInput, maxResults: number): Record<string, unknown> {
  return {
    searchStringsArray: [input.query],
    locationQuery: input.geography,
    maxCrawledPlacesPerSearch: maxResults,
    language: "es",
    countryCode: "ES",
    skipClosedPlaces: true,
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    scrapeSocialMediaProfiles: {
      facebooks: false,
      instagrams: false,
      youtubes: false,
      tiktoks: false,
      twitters: false,
    },
    maximumLeadsEnrichmentRecords: 0,
    verifyLeadsEnrichmentEmails: false,
    maxReviews: 0,
    scrapeReviewsPersonalData: false,
    maxImages: 0,
    scrapeImageAuthors: false,
    enableCompetitorAnalysis: false,
    maxCompetitorsToAnalyze: 0,
    includeWebResults: false,
    scrapeDirectories: false,
    scrapeTableReservationProvider: false,
    scrapeOrderOnline: false,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function mapCompassItemToPlaceResult(item: Record<string, unknown>): MapsPlaceResult | null {
  const name = firstString(item.title, item.name);
  if (!name) return null;

  const location = item.location && typeof item.location === "object" ? (item.location as Record<string, unknown>) : {};
  return {
    externalPlaceId: firstString(item.placeId),
    name,
    category: firstString(item.categoryName, item.category, Array.isArray(item.categories) ? item.categories[0] : null),
    address: firstString(item.address, item.street),
    postalCode: firstString(item.postalCode, item.zip),
    province: firstString(item.state, item.province),
    city: firstString(item.city),
    countryCode: firstString(item.countryCode, item.country)?.toUpperCase() ?? null,
    websiteUrl: firstString(item.website, item.websiteUrl),
    phone: firstString(item.phoneUnformatted, item.phone),
    latitude: firstNumber(item.lat, location.lat),
    longitude: firstNumber(item.lng, location.lng),
    rating: firstNumber(item.totalScore, item.rating),
    reviewCount: firstNumber(item.reviewsCount, item.reviewCount),
    sourceUrl: firstString(item.url, item.googleMapsUrl),
  };
}