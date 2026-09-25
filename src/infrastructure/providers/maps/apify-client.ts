/**
 * Low-level Apify REST client (Prompt 7 §15 async execution pattern). Only
 * three documented endpoints are used, all from https://docs.apify.com/api/v2:
 *   - POST /v2/acts/{actorId}/runs           — start an Actor run (async, returns immediately)
 *   - GET  /v2/actor-runs/{runId}             — poll run status/metadata (incl. usageTotalUsd)
 *   - GET  /v2/datasets/{datasetId}/items     — fetch the run's resulting dataset items
 *
 * No endpoint here is guessed — every path matches Apify's own API
 * reference. The actor's own INPUT schema (search terms, geography, etc.)
 * is still actor-specific and documented on that actor's Apify Store page;
 * `buildMapsActorInput` in `apify-provider.ts` uses the field names that are
 * conventional across the Google Maps actor family named in the actor
 * registry, and is intentionally defensive about actor-specific output
 * shape when mapping results back.
 */

const APIFY_API_BASE_URL = "https://api.apify.com/v2";

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "ABORTING"
  | "ABORTED";

export interface ApifyRun {
  id: string;
  actId: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  usageTotalUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export class ApifyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApifyRequestError";
  }
}

interface ApifyClientOptions {
  apiToken: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class ApifyClient {
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ApifyClientOptions) {
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? APIFY_API_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" };
  }

  private async parseOrThrow(response: Response, action: string): Promise<unknown> {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApifyRequestError(`Apify ${action} failed: HTTP ${response.status} ${body}`.trim(), response.status);
    }
    return response.json();
  }

  /**
   * Starts an Actor run asynchronously (does not block on completion —
   * §15 "do not keep a Vercel function open waiting for large actor runs").
   * `maxTotalChargeUsd` is Apify's own documented cost-guard query param.
   */
  async startRun(actorId: string, input: Record<string, unknown>, options: { maxTotalChargeUsd?: number; timeoutSecs?: number } = {}): Promise<ApifyRun> {
    const params = new URLSearchParams();
    if (options.maxTotalChargeUsd !== undefined) params.set("maxTotalChargeUsd", String(options.maxTotalChargeUsd));
    if (options.timeoutSecs !== undefined) params.set("timeout", String(options.timeoutSecs));
    const query = params.toString() ? `?${params.toString()}` : "";

    const response = await this.fetchImpl(`${this.baseUrl}/acts/${encodeURIComponent(actorId)}/runs${query}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(input),
    });
    const body = (await this.parseOrThrow(response, "start run")) as { data: ApifyRun };
    return body.data;
  }

  async getRun(runId: string): Promise<ApifyRun> {
    const response = await this.fetchImpl(`${this.baseUrl}/actor-runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const body = (await this.parseOrThrow(response, "get run status")) as { data: ApifyRun };
    return body.data;
  }

  async getDatasetItems(datasetId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    const params = new URLSearchParams({ clean: "true" });
    if (options.limit !== undefined) params.set("limit", String(options.limit));

    const response = await this.fetchImpl(`${this.baseUrl}/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApifyRequestError(`Apify get dataset items failed: HTTP ${response.status} ${body}`.trim(), response.status);
    }
    return (await response.json()) as unknown[];
  }

  static readonly TERMINAL_STATUSES: readonly ApifyRunStatus[] = ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"];

  /**
   * Starts a run and polls until a terminal status or `maxWaitMs` elapses.
   * This keeps the async start/poll/fetch pattern from §15 while still
   * returning a single Promise the `MapsDiscoveryProvider.search()`
   * interface expects — the polling itself happens inside a cron-triggered
   * background job (Gate E), never inside a user-facing request.
   */
  async runAndWait(
    actorId: string,
    input: Record<string, unknown>,
    options: { maxTotalChargeUsd?: number; maxWaitMs?: number; pollIntervalMs?: number } = {},
  ): Promise<ApifyRun> {
    const maxWaitMs = options.maxWaitMs ?? 55_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    let run = await this.startRun(actorId, input, { maxTotalChargeUsd: options.maxTotalChargeUsd });
    const deadline = Date.now() + maxWaitMs;

    while (!ApifyClient.TERMINAL_STATUSES.includes(run.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      run = await this.getRun(run.id);
    }
    return run;
  }
}
