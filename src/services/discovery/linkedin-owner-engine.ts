import type { DiscoveryEngine, RawCandidate, SearchSeed } from "@/domain/discovery/types";
import type { SerpDiscoveryProvider } from "@/domain/providers/types";
import { selectNextSeeds } from "./geography-planner";
import type { LinkedInRawPayload } from "./candidate-processor";

/**
 * LinkedIn Owner engine (Prompt 2 §2.9): public SERP discovery only, never
 * authenticated scraping. For each profile-shaped result found under a
 * role-family query, issues one follow-up SERP query to resolve the
 * employer's public website/domain (needed later for Spain verification
 * and public contact-point discovery) — it never guesses a personal email
 * pattern itself; that stays entirely out of scope of this engine.
 */
export class LinkedInOwnerEngine implements DiscoveryEngine {
  readonly engineType = "linkedin_owner" as const;

  constructor(private readonly provider: SerpDiscoveryProvider) {}

  validateConfig(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  seeds: SearchSeed[] = [];

  async planDiscoveryBatch(input: { campaignId: string; remainingTarget: number }): Promise<{ seeds: SearchSeed[] }> {
    const catalogSize = Math.max(1, Math.ceil(input.remainingTarget / 10)); // lowest-yield engine per §0.4's worked example
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

    let profileResults;
    try {
      const output = await this.provider.search({ query: `${input.seed.query} ${input.seed.geography}`, maxResults: 10 });
      providerCalls += 1;
      profileResults = output.results.filter((result) => result.domain === "linkedin.com");
    } catch {
      return { rawCandidates: [], providerCalls: 1, providerErrors: 1, latencyMs: Date.now() - start };
    }

    const rawCandidates: RawCandidate[] = [];
    for (const [index, profile] of profileResults.entries()) {
      let resolvedEmployerDomain: string | null = null;
      try {
        const employerLookup = await this.provider.search({ query: `${profile.title} sitio web oficial`, maxResults: 3 });
        providerCalls += 1;
        resolvedEmployerDomain = employerLookup.results.find((r) => r.domain && r.domain !== "linkedin.com")?.domain ?? null;
      } catch {
        providerErrors += 1;
      }

      rawCandidates.push({
        id: `raw_${input.seed.id}_${index}`,
        campaignId: input.seed.campaignId,
        engineType: this.engineType,
        sourceExternalId: profile.url,
        sourceUrl: profile.url,
        rawPayload: { kind: "linkedin", profile, resolvedEmployerDomain, geography: input.seed.geography } satisfies LinkedInRawPayload,
        discoveredAt: new Date().toISOString(),
      });
    }

    return { rawCandidates, providerCalls, providerErrors, latencyMs: Date.now() - start };
  }
}
