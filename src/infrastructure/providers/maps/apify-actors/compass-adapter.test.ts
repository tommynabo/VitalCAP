import { describe, expect, it } from "vitest";
import { buildCompassActorInput, mapCompassItemToPlaceResult } from "./compass-adapter";

describe("Compass adapter", () => {
  const search = { query: "farmacia", geography: "Barcelona, Spain", pageToken: null };

  it("builds the current bounded low-cost input", () => {
    const input = buildCompassActorInput(search, 5);
    expect(input.searchStringsArray).toEqual(["farmacia"]);
    expect(input.locationQuery).toBe("Barcelona, Spain");
    expect(input.maxCrawledPlacesPerSearch).toBe(5);
    expect(input.countryCode).toBe("ES");
    expect(input.language).toBe("es");
    expect(input.scrapeContacts).toBe(false);
    expect(input.maximumLeadsEnrichmentRecords).toBe(0);
    expect(input.maxReviews).toBe(0);
    expect(input.maxImages).toBe(0);
    expect(input.enableCompetitorAnalysis).toBe(false);
  });

  it("preserves Compass place ID and maps normalized fields", () => {
    const result = mapCompassItemToPlaceResult({
      title: "Farmacia Central",
      placeId: "ChIJreal-place-id",
      categoryName: "Farmacia",
      address: "Carrer Major 1",
      postalCode: "08001",
      city: "Barcelona",
      state: "Barcelona",
      countryCode: "ES",
      website: "https://example.es",
      phoneUnformatted: "+34930000000",
      location: { lat: 41.38, lng: 2.17 },
      totalScore: 4.7,
      reviewsCount: 12,
      url: "https://www.google.com/maps/place/example",
    });
    expect(result).toMatchObject({
      externalPlaceId: "ChIJreal-place-id",
      name: "Farmacia Central",
      countryCode: "ES",
      latitude: 41.38,
      longitude: 2.17,
    });
  });

  it("does not invent a place ID or country", () => {
    const result = mapCompassItemToPlaceResult({ title: "Farmacia Sin Evidencia" });
    expect(result?.externalPlaceId).toBeNull();
    expect(result?.countryCode).toBeNull();
  });

  it("skips malformed rows without a business name", () => {
    expect(mapCompassItemToPlaceResult({ placeId: "ChIJorphan" })).toBeNull();
  });
});
