import { safeFetchPage } from "@/lib/security/safe-fetch";
import type { WebsiteFetcher } from "@/domain/providers/types";
import type { EngineType } from "@/domain/campaigns/types";
import type { DiscoveryEngine } from "@/domain/discovery/types";
import { MapsFastEngine } from "@/services/discovery/maps-fast-engine";
import { MapsDeepEngine } from "@/services/discovery/maps-deep-engine";
import { GoogleSerpEngine } from "@/services/discovery/google-serp-engine";
import { LinkedInOwnerEngine } from "@/services/discovery/linkedin-owner-engine";
import { HybridFillEngine } from "@/services/discovery/hybrid-fill-engine";
import { createMapsDiscoveryProvider, createSerpDiscoveryProvider } from "@/infrastructure/providers/provider-factory";

/** `WebsiteFetcher` backed by the real SSRF-safe fetch wrapper (Prompt 2 §2.5) — the only concrete adapter this interface has outside tests. */
export const realWebsiteFetcher: WebsiteFetcher = {
  fetchPage: (url) => safeFetchPage(url),
};

/**
 * Builds the real `DiscoveryEngine` for one engine type (Gate E composition
 * root for cron routes — mirrors `provider-factory.ts`'s "one place knows
 * both env var and concrete class" rule, one layer up). `hybrid_fill`
 * delegates to freshly-built `maps_fast`/`google_serp` engines, matching
 * `HybridFillEngine`'s own delegate contract.
 */
export function createDiscoveryEngine(workspaceId: string, engineType: EngineType): DiscoveryEngine {
  switch (engineType) {
    case "maps_fast":
      return new MapsFastEngine(createMapsDiscoveryProvider(workspaceId, "maps_fast"));
    case "maps_deep":
      return new MapsDeepEngine(createMapsDiscoveryProvider(workspaceId, "maps_deep"), realWebsiteFetcher, createSerpDiscoveryProvider(workspaceId));
    case "google_serp":
      return new GoogleSerpEngine(createSerpDiscoveryProvider(workspaceId));
    case "linkedin_owner":
      return new LinkedInOwnerEngine(createSerpDiscoveryProvider(workspaceId));
    case "hybrid_fill":
      return new HybridFillEngine({
        maps_fast: new MapsFastEngine(createMapsDiscoveryProvider(workspaceId, "maps_fast")),
        google_serp: new GoogleSerpEngine(createSerpDiscoveryProvider(workspaceId)),
      });
    default: {
      const exhaustive: never = engineType;
      throw new Error(`Unknown engine type: ${String(exhaustive)}`);
    }
  }
}

/** Best-effort provider label for `account_sources.source_provider` audit metadata — `hybrid_fill` delegates to more than one underlying provider, so this is an approximation, not an exact record of which one actually ran (see `account-sources` write site for the honest caveat). */
export function providerLabelForEngine(engineType: EngineType): string {
  switch (engineType) {
    case "maps_fast":
    case "maps_deep":
    case "hybrid_fill":
      return "apify";
    case "google_serp":
    case "linkedin_owner":
      return "serper";
    default: {
      const exhaustive: never = engineType;
      throw new Error(`Unknown engine type: ${String(exhaustive)}`);
    }
  }
}
