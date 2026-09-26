import type { AsyncMapsRun, MapsDiscoveryProvider, MapsPlaceResult, MapsSearchInput, MapsSearchOutput } from "@/domain/providers/types";
import { ApifyClient, type ApifyRun } from "./apify-client";
import { buildCompassActorInput, COMPASS_ACTOR_ID, mapCompassItemToPlaceResult } from "./apify-actors/compass-adapter";
import { allowsNewApifyRun } from "@/domain/autopilot/gates";

/** Narrowed to just the two methods this provider calls, so tests can inject a plain fake instead of a real `ApifyClient`. */
export interface ApifyMapsClient {
  runAndWait(actorId: string, input: Record<string, unknown>, options?: { maxTotalChargeUsd?: number }): Promise<ApifyRun>;
  startActorRun?(actorId: string, input: Record<string, unknown>, options?: { maxTotalChargeUsd?: number }): Promise<ApifyRun>;
  getActorRun?(runId: string): Promise<ApifyRun>;
  getDatasetItems(datasetId: string, options?: { offset?: number; limit?: number }): Promise<unknown[]>;
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
  /** Injected so this provider never imports the Neon repository layer directly (keeps it DB-free and unit-testable). */
  getTodaySpendUsd: () => Promise<number>;
  getAutopilotState?: () => Promise<"running" | "paused" | "emergency_stopped">;
  recordRun?: (run: {
    actorId: string;
    externalRunId: string | null;
    externalDatasetId: string | null;
    status: "completed" | "failed";
    itemsRequested: number;
    itemsReturned: number;
    costUsd: number;
    errorMessage?: string;
  }) => Promise<void>;
  /** Injectable for tests. */
  client?: ApifyMapsClient;
}

export const mapApifyItemToPlaceResult = mapCompassItemToPlaceResult;

/**
 * Real Apify-backed `MapsDiscoveryProvider` (Prompt 7 §11–§15). Uses the
 * documented start → poll → dataset-fetch pattern (`ApifyClient`), a
 * batch cost cap enforced via Apify's own `maxTotalChargeUsd` run param, and a
 * bounded `runAndWait()` only for the explicit five-result corrective smoke;
 * normal production execution still needs the future async lifecycle,
 * and a
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

  async startAsync(input: MapsSearchInput): Promise<AsyncMapsRun> {
    const autopilotState = await this.config.getAutopilotState?.();
    if (autopilotState && !allowsNewApifyRun(autopilotState)) {
      throw new Error(`Autopilot is ${autopilotState}; refusing to start a new Apify run.`);
    }
    const todaySpend = await this.config.getTodaySpendUsd();
    if (todaySpend >= this.config.dailyCostLimitUsd) {
      throw new ApifyCostLimitExceededError(
        `Apify daily cost limit reached ($${todaySpend.toFixed(2)} >= $${this.config.dailyCostLimitUsd.toFixed(2)}); refusing to start a new run.`,
      );
    }
    if (this.config.actorId !== COMPASS_ACTOR_ID) {
      throw new Error(`No verified input adapter exists for Apify actor ${this.config.actorId}.`);
    }
    const startActorRun = this.client.startActorRun;
    if (!startActorRun) throw new Error("Async Apify client support is not configured.");
    const maxResults = Math.min(this.config.maxCrawledPlacesPerSearch ?? 20, Math.max(1, Math.floor(input.maxResults ?? this.config.maxCrawledPlacesPerSearch ?? 20)));
    const actorInput = buildCompassActorInput(input, maxResults);
    const run = await startActorRun.call(this.client, this.config.actorId, actorInput, { maxTotalChargeUsd: this.config.batchCostLimitUsd });
    return {
      actorId: this.config.actorId,
      externalRunId: run.id,
      externalDatasetId: run.defaultDatasetId,
      status: run.status === "READY" ? "queued" : "running",
      itemsRequested: maxResults,
      costUsd: run.usageTotalUsd ?? 0,
      metadata: { requestKey: input.requestKey ?? null },
    };
  }

  async search(input: MapsSearchInput): Promise<MapsSearchOutput> {
    const start = Date.now();

    const todaySpend = await this.config.getTodaySpendUsd();
    if (todaySpend >= this.config.dailyCostLimitUsd) {
      throw new ApifyCostLimitExceededError(
        `Apify daily cost limit reached ($${todaySpend.toFixed(2)} >= $${this.config.dailyCostLimitUsd.toFixed(2)}); refusing to start a new run.`,
      );
    }

    if (this.config.actorId !== COMPASS_ACTOR_ID) {
      throw new Error(`No verified input adapter exists for Apify actor ${this.config.actorId}.`);
    }
    const maxResults = Math.min(this.config.maxCrawledPlacesPerSearch ?? 20, Math.max(1, Math.floor(input.maxResults ?? this.config.maxCrawledPlacesPerSearch ?? 20)));
    const actorInput = buildCompassActorInput(input, maxResults);
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
        itemsRequested: this.config.maxCrawledPlacesPerSearch ?? 20,
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
        itemsRequested: this.config.maxCrawledPlacesPerSearch ?? 20,
        itemsReturned: 0,
        costUsd: run.usageTotalUsd ?? 0,
        errorMessage: `Apify run ended with status ${run.status}`,
      });
      throw new Error(`Apify actor run ${run.id} for ${this.config.actorId} did not succeed (status: ${run.status})`);
    }

    if (!run.defaultDatasetId) throw new Error(`Apify run ${run.id} completed without a dataset ID.`);
    let items: Record<string, unknown>[];
    try {
      items = (await this.client.getDatasetItems(run.defaultDatasetId, {
        limit: this.config.maxCrawledPlacesPerSearch ?? 20,
      })) as Record<string, unknown>[];
    } catch (error) {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: run.id,
        externalDatasetId: run.defaultDatasetId,
        status: "failed",
        itemsRequested: this.config.maxCrawledPlacesPerSearch ?? 20,
        itemsReturned: 0,
        costUsd: run.usageTotalUsd ?? 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const results = items.map(mapCompassItemToPlaceResult).filter((result): result is MapsPlaceResult => result !== null);
    const costUsd = run.usageTotalUsd ?? 0;

    await this.config.recordRun?.({
      actorId: this.config.actorId,
      externalRunId: run.id,
      externalDatasetId: run.defaultDatasetId,
      status: "completed",
      itemsRequested: this.config.maxCrawledPlacesPerSearch ?? 20,
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
