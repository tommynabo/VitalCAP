import type { AsyncMapsRun, MapsDiscoveryProvider, MapsPlaceResult, MapsSearchInput, MapsSearchOutput } from "@/domain/providers/types";
import { ProviderBudgetExceededError, ProviderConfigurationError } from "@/domain/providers/errors";
import { ApifyClient, type ApifyRun } from "./apify-client";
import { buildCompassActorInput, COMPASS_ACTOR_ID, mapCompassItemToPlaceResult } from "./apify-actors/compass-adapter";
import { allowsNewApifyRun } from "@/domain/autopilot/gates";
import { APIFY_MAX_RESULTS_PER_SEARCH, resolveApifyMaxResults } from "@/services/discovery/apify-request-capacity";

function markProviderCallAttempted(error: unknown): Error & { providerCallAttempted: true } {
  const providerError = error instanceof Error ? error : new Error(String(error));
  Object.assign(providerError, { providerCallAttempted: true as const });
  return providerError as Error & { providerCallAttempted: true };
}

/** Narrowed to just the two methods this provider calls, so tests can inject a plain fake instead of a real `ApifyClient`. */
export interface ApifyMapsClient {
  runAndWait(actorId: string, input: Record<string, unknown>, options?: { maxTotalChargeUsd?: number }): Promise<ApifyRun>;
  startActorRun?(actorId: string, input: Record<string, unknown>, options?: { maxTotalChargeUsd?: number }): Promise<ApifyRun>;
  getActorRun?(runId: string): Promise<ApifyRun>;
  getDatasetItems(datasetId: string, options?: { offset?: number; limit?: number }): Promise<unknown[]>;
}

export class ApifyCostLimitExceededError extends ProviderBudgetExceededError {
  constructor(message: string, retryAt = new Date(Date.now() + 24 * 60 * 60 * 1000)) {
    super(message, retryAt);
    this.name = "ApifyCostLimitExceededError";
  }
}

export interface ApifyMapsProviderConfig {
  apiToken: string;
  actorId: string;
  dailyCostLimitUsd: number;
  workspaceDailyCostLimitUsd?: number | null;
  getWorkspaceDailyCostLimitUsd?: () => Promise<number | null>;
  batchCostLimitUsd: number;
  maxCrawledPlacesPerSearch?: number;
  getReservedCostUsd: (requestKey: string) => Promise<number>;
  getAutopilotState?: () => Promise<"running" | "paused" | "emergency_stopped" | "system_paused">;
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

  private async getEffectiveDailyLimit(): Promise<number> {
    const workspaceLimit = this.config.getWorkspaceDailyCostLimitUsd
      ? await this.config.getWorkspaceDailyCostLimitUsd()
      : this.config.workspaceDailyCostLimitUsd;
    return Math.min(this.config.dailyCostLimitUsd, workspaceLimit ?? this.config.dailyCostLimitUsd);
  }

  private async getReservedChargeLimit(requestKey?: string): Promise<number> {
    if (!requestKey) throw new ProviderConfigurationError("Apify run requires an idempotent persisted cost reservation.");
    const reservedCostUsd = await this.config.getReservedCostUsd(requestKey);
    const hardLimitUsd = Math.min(await this.getEffectiveDailyLimit(), 5, this.config.batchCostLimitUsd, 0.5);
    if (!Number.isFinite(reservedCostUsd) || reservedCostUsd <= 0 || reservedCostUsd > hardLimitUsd) {
      throw new ApifyCostLimitExceededError("Apify run has no valid reservation within the configured hard cost limits.");
    }
    return reservedCostUsd;
  }

  async startAsync(input: MapsSearchInput): Promise<AsyncMapsRun> {
    const autopilotState = await this.config.getAutopilotState?.();
    if (autopilotState && !allowsNewApifyRun(autopilotState)) {
      throw new ProviderConfigurationError(`Autopilot is ${autopilotState}; refusing to start a new Apify run.`);
    }
    const maxTotalChargeUsd = await this.getReservedChargeLimit(input.requestKey);
    if (this.config.actorId !== COMPASS_ACTOR_ID) {
      throw new ProviderConfigurationError(`No verified input adapter exists for Apify actor ${this.config.actorId}.`);
    }
    const startActorRun = this.client.startActorRun;
    if (!startActorRun) throw new ProviderConfigurationError("Async Apify client support is not configured.");
    const maxResults = resolveApifyMaxResults({
      requestedItems: input.maxResults ?? this.config.maxCrawledPlacesPerSearch ?? APIFY_MAX_RESULTS_PER_SEARCH,
      configuredMaxResults: this.config.maxCrawledPlacesPerSearch ?? APIFY_MAX_RESULTS_PER_SEARCH,
      batchCostLimitUsd: this.config.batchCostLimitUsd,
    });
    if (maxResults === 0) throw new ApifyCostLimitExceededError("Apify batch budget cannot fund one requested result.");
    const actorInput = buildCompassActorInput(input, maxResults);
    let run;
    try {
      run = await startActorRun.call(this.client, this.config.actorId, actorInput, { maxTotalChargeUsd });
    } catch (error) {
      throw markProviderCallAttempted(error);
    }
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

    const maxTotalChargeUsd = await this.getReservedChargeLimit(input.requestKey);

    if (this.config.actorId !== COMPASS_ACTOR_ID) {
      throw new ProviderConfigurationError(`No verified input adapter exists for Apify actor ${this.config.actorId}.`);
    }
    const maxResults = resolveApifyMaxResults({
      requestedItems: input.maxResults ?? this.config.maxCrawledPlacesPerSearch ?? APIFY_MAX_RESULTS_PER_SEARCH,
      configuredMaxResults: this.config.maxCrawledPlacesPerSearch ?? APIFY_MAX_RESULTS_PER_SEARCH,
      batchCostLimitUsd: this.config.batchCostLimitUsd,
    });
    if (maxResults === 0) throw new ApifyCostLimitExceededError("Apify batch budget cannot fund one requested result.");
    const actorInput = buildCompassActorInput(input, maxResults);
    let run;
    try {
      run = await this.client.runAndWait(this.config.actorId, actorInput, {
        maxTotalChargeUsd,
      });
    } catch (error) {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: null,
        externalDatasetId: null,
        status: "failed",
        itemsRequested: maxResults,
        itemsReturned: 0,
        costUsd: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw markProviderCallAttempted(error);
    }

    if (run.status !== "SUCCEEDED") {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: run.id,
        externalDatasetId: run.defaultDatasetId,
        status: "failed",
        itemsRequested: maxResults,
        itemsReturned: 0,
        costUsd: run.usageTotalUsd ?? 0,
        errorMessage: `Apify run ended with status ${run.status}`,
      });
      throw new ProviderConfigurationError(`Apify actor run ${run.id} for ${this.config.actorId} did not succeed (status: ${run.status})`);
    }

    if (!run.defaultDatasetId) throw new Error(`Apify run ${run.id} completed without a dataset ID.`);
    let items: Record<string, unknown>[];
    try {
      items = (await this.client.getDatasetItems(run.defaultDatasetId, {
        limit: maxResults,
      })) as Record<string, unknown>[];
    } catch (error) {
      await this.config.recordRun?.({
        actorId: this.config.actorId,
        externalRunId: run.id,
        externalDatasetId: run.defaultDatasetId,
        status: "failed",
        itemsRequested: maxResults,
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
      itemsRequested: maxResults,
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
