import type { MapsDiscoveryProvider, MapsPlaceResult, MapsSearchInput, MapsSearchOutput } from "@/domain/providers/types";
import { ApifyClient, type ApifyRun } from "./apify-client";

/** Narrowed to just the two methods this provider calls, so tests can inject a plain fake instead of a real `ApifyClient`. */
export interface ApifyMapsClient {
  runAndWait(actorId: string, input: Record<string, unknown>, options?: { maxTotalChargeUsd?: number }): Promise<ApifyRun>;
  getDatasetItems(datasetId: string, options?: { limit?: number }): Promise<unknown[]>;
}

export class ApifyCostLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApifyCostLimitExceededError";
  }
}

export interface ApifyMapsProviderConfig {
  apiToken: string;
  actorId: string;
  dailyCostLimitUsd: number;
  batchCostLimitUsd: number;
  maxCrawledPlacesPerSearch?: number;
  countryCode?: string;
  language?: string;
  /** Injected so this provider never imports the Neon repository layer directly (keeps it DB-free and unit-testable). */
  getTodaySpendUsd: () => Promise<number>;
  recordRun?: (run: {
    actorId: string;
    externalRunId: string | null;
    externalDatasetId: string | null;
    status: "completed" | "failed";
    itemsReturned: number;
    costUsd: number;
    errorMessage?: string;
  }) => Promise<void>;
  /** Injectable for tests. */
  client?: ApifyMapsClient;
}

/**
 * Maps-actor-input field names shared across the Google Maps actor family
 * named in `actor-registry.ts` (`searchStringsArray`/`locationQuery`/
 * `maxCrawledPlacesPerSearch`/`language`). Verify against the specific
 * actor's own Apify Store input schema before switching `actorId` in
 * production — this shape is the common convention, not guaranteed
 * identical for every future candidate.
 */
function buildMapsActorInput(input: MapsSearchInput, config: ApifyMapsProviderConfig): Record<string, unknown> {
  return {
    searchStringsArray: [input.query],
    locationQuery: input.geography,
    countryCode: (config.countryCode ?? "es").toLowerCase(),
    language: config.language ?? "es",
    maxCrawledPlacesPerSearch: config.maxCrawledPlacesPerSearch ?? 20,
    scrapeContactInfo: true,
    maximumLeadsEnrichmentRecords: 0,
    skipClosedPlaces: true,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Defensive mapping from an Apify Google-Maps-actor dataset item to
 * `MapsPlaceResult`. Different actors in the registry use slightly
 * different field names for the same concept (e.g. `title` vs `name`,
 * `placeId` vs `cid`), so every field tries the common aliases seen across
 * the actor family before falling back to `null`.
 */
export function mapApifyItemToPlaceResult(item: Record<string, unknown>): MapsPlaceResult {
  const location = (item.location as Record<string, unknown> | undefined) ?? {};
  return {
    externalPlaceId: firstString(item.placeId, item.cid, item.fid, item.url) ?? `unknown_${JSON.stringify(item).slice(0, 32)}`,
    name: firstString(item.title, item.name) ?? "Unknown",
    category: firstString(item.categoryName, item.category),
    address: firstString(item.address, item.street),
    postalCode: firstString(item.postalCode, item.zip),
    province: firstString(item.state, item.province),
    city: firstString(item.city),
    countryCode: firstString(item.countryCode, item.country) ?? "ES",
    websiteUrl: firstString(item.website, item.websiteUrl),
    phone: firstString(item.phone, item.phoneUnformatted),
    latitude: firstNumber(item.lat, location.lat),
    longitude: firstNumber(item.lng, location.lng),
    rating: firstNumber(item.totalScore, item.rating),
    reviewCount: firstNumber(item.reviewsCount, item.reviewCount),
    sourceUrl: firstString(item.url, item.googleMapsUrl),
  };
}

/**
 * Real Apify-backed `MapsDiscoveryProvider` (Prompt 7 §11–§15). Uses the
 * documented async run → poll → dataset-fetch pattern (`ApifyClient`), a
 * batch cost cap enforced via Apify's own `maxTotalChargeUsd` run param, and
 * a daily cost cap checked before starting any run (via an injected spend
 * lookup so this class stays DB-free). Every run is persisted (actor ID,
 * run ID, dataset ID, status, item count, cost) through the optional
 * `recordRun` hook, satisfying the §14 cost-guard persistence requirement.
 */
export class ApifyMapsDiscoveryProvider implements MapsDiscoveryProvider {
  readonly providerName = "apify-maps";
  private readonly client: ApifyMapsClient;

  constructor(private readonly config: ApifyMapsProviderConfig) {
    this.client = config.client ?? new ApifyClient({ apiToken: config.apiToken });
  }

  async search(input: MapsSearchInput): Promise<MapsSearchOutput> {
    const start = Date.now();

    const todaySpend = await this.config.getTodaySpendUsd();
    if (todaySpend >= this.config.dailyCostLimitUsd) {
      throw new ApifyCostLimitExceededError(
        `Apify daily cost limit reached ($${todaySpend.toFixed(2)} >= $${this.config.dailyCostLimitUsd.toFixed(2)}); refusing to start a new run.`,
      );
    }

    const actorInput = buildMapsActorInput(input, this.config);
    let run;
    try {
      run = await this.client.runAndWait(this.config.actorId, actorInput, {
        maxTotalChargeUsd: this.config.batchCostLimitUsd,
      });
    } catch (error) {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: null,
        externalDatasetId: null,
        status: "failed",
        itemsReturned: 0,
        costUsd: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (run.status !== "SUCCEEDED") {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: run.id,
        externalDatasetId: run.defaultDatasetId,
        status: "failed",
        itemsReturned: 0,
        costUsd: run.usageTotalUsd ?? 0,
        errorMessage: `Apify run ended with status ${run.status}`,
      });
      throw new Error(`Apify actor run ${run.id} for ${this.config.actorId} did not succeed (status: ${run.status})`);
    }

    const items = (await this.client.getDatasetItems(run.defaultDatasetId, {
      limit: this.config.maxCrawledPlacesPerSearch ?? 20,
    })) as Record<string, unknown>[];
    const results = items.map(mapApifyItemToPlaceResult);
    const costUsd = run.usageTotalUsd ?? 0;

    await this.config.recordRun?.({
      actorId: this.config.actorId,
      externalRunId: run.id,
      externalDatasetId: run.defaultDatasetId,
      status: "completed",
      itemsReturned: results.length,
      costUsd,
    });

    return {
      results,
      // Each Apify run above is a single bounded batch — pagination across
      // multiple runs is handled by the geography/seed planner re-invoking
      // `search()` with a different seed, not by a provider-level page token.
      nextPageToken: null,
      usage: {
        calls: 1,
        items: results.length,
        errors: 0,
        totalLatencyMs: Date.now() - start,
        costUsd,
        quotaRemaining: null,
      },
    };
  }
}
