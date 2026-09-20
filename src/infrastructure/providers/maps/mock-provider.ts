import type { MapsDiscoveryProvider, MapsPlaceResult, MapsSearchInput, MapsSearchOutput } from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `MapsDiscoveryProvider` (Prompt 2 §2.3/§2.7 — ships
 * before any real key is configured). Deterministically synthesizes a
 * plausible page of pharmacy/parapharmacy-like place results for a given
 * query+geography so engines and tests never need a live Maps API key.
 */
export class MockMapsDiscoveryProvider implements MapsDiscoveryProvider {
  readonly providerName = "mock-maps";

  constructor(private readonly resultsPerPage = 8) {}

  async search(input: MapsSearchInput): Promise<MapsSearchOutput> {
    const pageIndex = input.pageToken ? Number(input.pageToken) : 0;
    const seed = hashString(`${input.query}|${input.geography}|${pageIndex}`);
    const random = seededRandom(seed);

    const results: MapsPlaceResult[] = Array.from({ length: this.resultsPerPage }, (_, index) => {
      const globalIndex = pageIndex * this.resultsPerPage + index;
      const placeId = `mock_place_${seed}_${globalIndex}`;
      const hasWebsite = random() > 0.25;
      return {
        externalPlaceId: placeId,
        name: `Farmacia ${input.geography} ${globalIndex + 1}`,
        category: random() > 0.7 ? "parafarmacia" : "farmacia",
        address: `Calle Mayor ${globalIndex + 1}, ${input.geography}`,
        postalCode: null,
        province: input.geography,
        city: input.geography,
        countryCode: "ES",
        websiteUrl: hasWebsite ? `https://farmacia-${globalIndex + 1}-${seed}.example.es` : null,
        phone: null,
        latitude: null,
        longitude: null,
        rating: Math.round(random() * 50) / 10,
        reviewCount: Math.floor(random() * 200),
        sourceUrl: `https://maps.example.com/place/${placeId}`,
      };
    });

    const hasMorePages = pageIndex < 2; // cap synthetic pagination at 3 pages so mock catalogs terminate
    return {
      results,
      nextPageToken: hasMorePages ? String(pageIndex + 1) : null,
      usage: { calls: 1, items: results.length, errors: 0, totalLatencyMs: 120, costUsd: 0.002 * results.length, quotaRemaining: null },
    };
  }
}
