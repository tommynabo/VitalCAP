import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { MapsDiscoveryProvider, SerpDiscoveryProvider, WebsiteFetcher } from "@/domain/providers/types";
import { selectNextSeeds } from "./geography-planner";
import { crawlWebsite } from "@/services/enrichment/website-crawler";
import type { MapsRawPayload } from "./candidate-processor";

/**
 * Maps Deep engine (Prompt 2 §2.4): same Maps search as Maps Fast, but for
 * every result that has a website, crawls it (contact/about/team/legal/
 * titular pages) and runs one targeted owner-search SERP query. Every named
 * contact this produces carries a public source URL — never an LLM guess.
 * Bounded by `maxDeepEnrichPerRun` so one seed run can't fan out into an
 * unbounded number of crawls/SERP calls.
 */
export class MapsDeepEngine implements DiscoveryEngine {
  readonly engineType = "maps_deep" as const;

  constructor(
    private readonly mapsProvider: MapsDiscoveryProvider,
    private readonly websiteFetcher: WebsiteFetcher,
    private readonly serpProvider: SerpDiscoveryProvider,
    private readonly maxDeepEnrichPerRun = 5,
  ) {}

  validateConfig(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  seeds: SearchSeed[] = [];

  async planDiscoveryBatch(input: { campaignId: string; remainingTarget: number }): Promise<{ seeds: SearchSeed[] }> {
    const catalogSize = Math.max(1, Math.ceil(input.remainingTarget / 4)); // deep enrichment yields fewer, higher-confidence contacts per seed
    return { seeds: selectNextSeeds(this.seeds, catalogSize, new Date()) };
  }

  async executeDiscovery(input: { seed: SearchSeed; dryRun: boolean }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
  }> {
    const start = Date.now();
    let providerCalls = 0;
    let providerErrors = 0;

    let placesResult;
    try {
      placesResult = await this.mapsProvider.search({ query: input.seed.query, geography: input.seed.geography, pageToken: null });
      providerCalls += 1;
    } catch {
      return { rawCandidates: [], providerCalls: 1, providerErrors: 1, latencyMs: Date.now() - start };
    }

    const rawCandidates: RawCandidate[] = [];
    let enrichedCount = 0;

    for (const place of placesResult.results) {
      const payload: MapsRawPayload = { kind: "maps", place };

      if (place.websiteUrl && enrichedCount < this.maxDeepEnrichPerRun) {
        enrichedCount += 1;
        try {
          const pages = await crawlWebsite(this.websiteFetcher, place.websiteUrl, { maxPages: 4 });
          payload.crawledPages = pages;
          providerCalls += pages.length;
        } catch {
          providerErrors += 1;
        }

        try {
          const ownerQuery = `${place.name} titular OR propietario ${input.seed.geography}`;
          const serpOutput = await this.serpProvider.search({ query: ownerQuery, maxResults: 5 });
          payload.ownerSerpEvidence = serpOutput.results;
          providerCalls += 1;
        } catch {
          providerErrors += 1;
        }
      }

      rawCandidates.push({
        id: `raw_${input.seed.id}_${place.externalPlaceId ?? place.name}`,
        campaignId: input.seed.campaignId,
        engineType: this.engineType,
        sourceExternalId: place.externalPlaceId,
        sourceUrl: place.sourceUrl,
        rawPayload: { ...payload },
        discoveredAt: new Date().toISOString(),
      });
    }

    return { rawCandidates, providerCalls, providerErrors, latencyMs: Date.now() - start };
  }
}
