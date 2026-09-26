import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { MapsDiscoveryProvider } from "@/domain/providers/types";
import { selectNextSeeds } from "./geography-planner";
import type { MapsRawPayload } from "./candidate-processor";

/**
 * Maps Fast engine (Prompt 2 §2.3): the high-throughput, low-cost source —
 * one Maps API page per seed run, no deep crawl. Website fetch + email
 * extraction + verification happen later, in the shared candidate
 * processor, not here — `executeDiscovery`'s only job is to emit raw
 * candidates and report provider usage (§2.1).
 */
export class MapsFastEngine implements DiscoveryEngine {
  readonly engineType = "maps_fast" as const;

  constructor(private readonly provider: MapsDiscoveryProvider) {}

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.categories && !Array.isArray(config.categories)) errors.push("categories must be an array when provided");
    return { valid: errors.length === 0, errors };
  }

  async planDiscoveryBatch(input: { campaignId: string; remainingTarget: number }): Promise<{ seeds: SearchSeed[] }> {
    const catalogSize = Math.max(1, Math.ceil(input.remainingTarget / 8)); // ~8 ready contacts assumed per seed run
    return { seeds: selectNextSeeds(this.seeds, catalogSize, new Date()) };
  }

  /** Seed catalog is caller-managed (persisted `search_seeds` rows in a real deployment); injected here so tests/simulations control it directly. */
  seeds: SearchSeed[] = [];

  async executeDiscovery(input: { seed: SearchSeed; dryRun: boolean; requestKey?: string }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
    providerRun?: import("@/domain/providers/types").AsyncMapsRun;
  }> {
    const start = Date.now();
    let providerErrors = 0;

    try {
      const searchInput = { query: input.seed.query, geography: input.seed.geography, pageToken: null, requestKey: input.requestKey };
      if (this.provider.startAsync) {
        const providerRun = await this.provider.startAsync(searchInput);
        return { rawCandidates: [], providerCalls: 1, providerErrors: 0, latencyMs: Date.now() - start, providerRun };
      }
      const output = await this.provider.search(searchInput);
      const rawCandidates: RawCandidate[] = output.results.map((place) => ({
        id: `raw_${input.seed.id}_${place.externalPlaceId ?? place.name}`,
        campaignId: input.seed.campaignId,
        engineType: this.engineType,
        sourceExternalId: place.externalPlaceId,
        sourceUrl: place.sourceUrl,
        rawPayload: { kind: "maps", place } satisfies MapsRawPayload,
        discoveredAt: new Date().toISOString(),
      }));
      return { rawCandidates, providerCalls: 1, providerErrors, latencyMs: Date.now() - start };
    } catch {
      providerErrors = 1;
      return { rawCandidates: [], providerCalls: 1, providerErrors, latencyMs: Date.now() - start };
    }
  }
}
