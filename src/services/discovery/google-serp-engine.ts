import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { SerpDiscoveryProvider } from "@/domain/providers/types";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
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

  async executeDiscovery(input: {
    seed: SearchSeed;
    dryRun: boolean;
    planningWindow?: string;
    maxResults?: number;
    maxProviderQueries?: number;
    probeExecutionId?: string;
  }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
    resultsReturned: number;
    providerCallSucceeded: boolean;
    providerCallErrorClass: string | null;
    filteredByPolicyResults: number;
  }> {
    const start = Date.now();
    const maxResults = Math.max(1, Math.min(10, Math.floor(input.maxResults ?? 10)));
    try {
      const output = await this.provider.search({
        query: `${input.seed.query} ${input.seed.geography}`,
        maxResults,
        ...(input.maxProviderQueries === 1 ? { maxRetries: 0 } : {}),
        ...(input.probeExecutionId ? { probeExecutionId: input.probeExecutionId } : {}),
        seedId: input.seed.id,
        planningWindow: input.planningWindow,
      });
      const businessResults = output.results.filter((result) => result.domain !== "linkedin.com");
      const filteredByPolicyResults = output.results.length - businessResults.length;
      const rawCandidates: RawCandidate[] = businessResults.map((result, index) => ({
        id: `raw_${input.seed.id}_${index}_${result.domain ?? "unknown"}`,
        campaignId: input.seed.campaignId,
        engineType: this.engineType,
        providerRunId: output.providerRunId,
        sourceExternalId: result.domain,
        sourceUrl: result.url,
        rawPayload: { kind: "serp", result, geography: input.seed.geography } satisfies SerpRawPayload,
        discoveredAt: new Date().toISOString(),
      }));
      return {
        rawCandidates,
        providerCalls: output.usage.calls,
        providerErrors: 0,
        latencyMs: Date.now() - start,
        resultsReturned: output.results.length,
        filteredByPolicyResults,
        providerCallSucceeded: true,
        providerCallErrorClass: null,
      };
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) throw error;
      const attempts = typeof error === "object" && error !== null && "httpAttempts" in error
        && typeof error.httpAttempts === "number"
        ? error.httpAttempts
        : 0;
      return {
        rawCandidates: [],
        providerCalls: attempts,
        providerErrors: 1,
        latencyMs: Date.now() - start,
        resultsReturned: 0,
        providerCallSucceeded: false,
        providerCallErrorClass: error instanceof Error ? error.constructor.name : typeof error,
        filteredByPolicyResults: 0,
      };
    }
  }
}
