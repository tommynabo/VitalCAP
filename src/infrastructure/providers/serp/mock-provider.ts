import type { SerpDiscoveryProvider, SerpResult, SerpSearchInput, SerpSearchOutput } from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `SerpDiscoveryProvider` (Prompt 2 §2.7). Backs both
 * the Google SERP engine (business/category queries) and the LinkedIn
 * Owner engine (role-family queries) — deterministically synthesizes
 * plausible public-search results, never a real network call.
 */
export class MockSerpDiscoveryProvider implements SerpDiscoveryProvider {
  readonly providerName = "mock-serp";

  async search(input: SerpSearchInput): Promise<SerpSearchOutput> {
    const seed = hashString(input.query);
    const random = seededRandom(seed);
    const isLinkedInQuery = /titular|propietario|dueñ|gerente|responsable/i.test(input.query);

    const results: SerpResult[] = Array.from({ length: Math.min(input.maxResults, 10) }, (_, index) => {
      if (isLinkedInQuery && random() > 0.4) {
        const personSeed = Math.floor(random() * 100000);
        return {
          title: `Perfil de LinkedIn — Titular Farmacéutico ${personSeed}`,
          url: `https://www.linkedin.com/in/titular-${seed}-${index}`,
          snippet: `Titular Farmacéutico en Farmacia ${input.query.split(" ").pop()} ${personSeed} · España`,
          domain: "linkedin.com",
        };
      }
      const businessSeed = Math.floor(random() * 100000);
      const domain = `farmacia-${businessSeed}.example.es`;
      return {
        title: `Farmacia ${businessSeed} — ${input.query}`,
        url: `https://${domain}/`,
        snippet: `Farmacia especializada en ${input.query}. Visítanos en nuestra tienda online.`,
        domain,
      };
    });

    return {
      results,
      usage: { calls: 1, items: results.length, errors: 0, totalLatencyMs: 90, costUsd: 0.001 * results.length, quotaRemaining: null },
    };
  }
}
