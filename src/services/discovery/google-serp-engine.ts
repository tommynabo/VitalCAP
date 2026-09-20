import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { SerpDiscoveryProvider } from "@/domain/providers/types";
import { selectNextSeeds } from "./geography-planner";
import type { SerpRawPayload } from "./candidate-processor";

/**
 * Google SERP engine (Prompt 2 §2.8): query-expansion discovery across
 * category × geography (× intent, folded into the seed's `query` by the
 * catalog builder). LinkedIn-domain results are filtered out here — they
 * belong to the LinkedIn Owner engine, not this one.
 */
export class GoogleSerpEngine implements DiscoveryEngine {
  readonly engineType = "google_serp" as const;

  constructor(private readonly provider: SerpDiscoveryProvider) {}

  validateConfig(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  seeds: SearchSeed[] = [];

  async planDiscoveryBatch(input: { campaignId: string; remainingTarget: number }): Promise<{ seeds: SearchSeed[] }> {
    const catalogSize = Math.max(1, Math.ceil(input.remainingTarget / 6));
    return { seeds: selectNextSeeds(this.seeds, catalogSize, new Date()) };
  }

  async executeDiscovery(input: { seed: SearchSeed; dryRun: boolean }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
  }> {
    const start = Date.now();
    try {
      const output = await this.provider.search({ query: `${input.seed.query} ${input.seed.geography}`, maxResults: 10 });
      const businessResults = output.results.filter((result) => result.domain !== "linkedin.com");
      const rawCandidates: RawCandidate[] = businessResults.map((result, index) => ({
        id: `raw_${input.seed.id}_${index}_${result.domain ?? "unknown"}`,
        campaignId: input.seed.campaignId,
        engineType: this.engineType,
        sourceExternalId: result.domain,
        sourceUrl: result.url,
        rawPayload: { kind: "serp", result, geography: input.seed.geography } satisfies SerpRawPayload,
        discoveredAt: new Date().toISOString(),
      }));
      return { rawCandidates, providerCalls: 1, providerErrors: 0, latencyMs: Date.now() - start };
    } catch {
      return { rawCandidates: [], providerCalls: 1, providerErrors: 1, latencyMs: Date.now() - start };
    }
  }
}
