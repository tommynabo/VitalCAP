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

import { ProviderAuthenticationError, ProviderBillingError, ProviderConfigurationError, ProviderFailureError, ProviderTransientError } from "@/domain/providers/errors";

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
  defaultDatasetId: string | null;
  usageTotalUsd: number | null;
  options?: { maxTotalChargeUsd?: number | null };
  startedAt: string;
  finishedAt: string | null;
  statusMessage?: string | null;
}

export interface ApifyAccountCostSnapshot {
  dayStart: string;
  dayEnd: string;
  actualSpendUsd: number;
  reservedSpendUsd: number;
  committedSpendUsd: number;
  runCount: number;
  runIds: string[];
}

export function reconcileApifyRunCost(reservedCostUsd: number, actualCostUsd: number): {
  reservedCostUsd: number;
  actualCostUsd: number;
  varianceUsd: number;
  exceedsReservation: boolean;
} {
  if (![reservedCostUsd, actualCostUsd].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new ProviderTransientError("Apify run cost reconciliation received an invalid amount.");
  }
  const varianceUsd = actualCostUsd - reservedCostUsd;
  return {
    reservedCostUsd,
    actualCostUsd,
    varianceUsd,
    exceedsReservation: varianceUsd > 0.000001,
  };
}

export type ApifyFailureKind = "transient" | "billing" | "authentication" | "configuration" | "actor_resource_limit";

function isActorMemoryLimit(detail: string): boolean {
  return /actor[-_ ]memory[-_ ]limit|memory[-_ ]limit|memory.{0,30}(limit|exceed)|out of memory|\boom\b/i.test(detail);
}

export function getApifyFailureKind(error: unknown): ApifyFailureKind | null {
  if (error instanceof ApifyRequestError) return error.failureKind;
  if (!(error instanceof ProviderFailureError)) return null;
  const failureKind = (error as ProviderFailureError & { failureKind?: unknown }).failureKind;
  return failureKind === "transient" || failureKind === "billing" || failureKind === "authentication"
    || failureKind === "configuration" || failureKind === "actor_resource_limit"
    ? failureKind
    : null;
}

export function getApifyFailureClass(error: unknown): "actor_memory_limit" | null {
  if (!(error instanceof ProviderFailureError)) return null;
  return (error as ProviderFailureError & { failureClass?: unknown }).failureClass === "actor_memory_limit"
    ? "actor_memory_limit"
    : null;
}

export function classifyApifyRunFailure(run: Pick<ApifyRun, "id" | "status" | "statusMessage">): ProviderFailureError & { failureKind: ApifyFailureKind } {
  const detail = run.statusMessage?.trim() ?? "";
  if (isActorMemoryLimit(detail)) {
    return Object.assign(new ProviderTransientError(`Apify Actor run ${run.id} ended with an actor memory limit.`), {
      failureKind: "actor_resource_limit" as const,
      failureClass: "actor_memory_limit" as const,
    });
  }
  const message = `Apify Actor run ${run.id} ended with status ${run.status}.`;
  if (/credit|billing|payment|402/i.test(detail)) return Object.assign(new ProviderBillingError(message), { failureKind: "billing" as const });
  if (/unauthori[sz]ed|forbidden|invalid token|authentication|401|403/i.test(detail)) return Object.assign(new ProviderAuthenticationError(message), { failureKind: "authentication" as const });
  if (/invalid input|input schema|validation|configuration|bad request/i.test(detail)) return Object.assign(new ProviderConfigurationError(message), { failureKind: "configuration" as const });
  return Object.assign(new ProviderTransientError(message), { failureKind: "transient" as const });
}

export class ApifyRequestError extends ProviderFailureError {
  readonly failureKind: ApifyFailureKind;
  readonly failureClass: "actor_memory_limit" | null;

  constructor(
    message: string,
    readonly status: number,
    failureKind?: ApifyFailureKind,
  ) {
    const now = Date.now();
    const retryDelay = failureKind === "actor_resource_limit"
      ? 30 * 60 * 1000
      : failureKind === "billing" || status === 402
      ? 30 * 60 * 1000
      : status === 401 || status === 403
        ? 6 * 60 * 60 * 1000
        : status === 408 || status === 425 || status === 429 || status >= 500
          ? 2 * 60 * 1000
          : null;
    const kind = failureKind === "actor_resource_limit"
      ? "transient"
      : failureKind ?? (status === 402
      ? "billing"
      : status === 401 || status === 403
        ? "authentication"
        : retryDelay === null
          ? "configuration"
          : "transient");
    super(message, kind, retryDelay === null ? null : new Date(now + retryDelay));
    this.name = "ApifyRequestError";
    this.failureKind = failureKind ?? kind;
    this.failureClass = failureKind === "actor_resource_limit" ? "actor_memory_limit" : null;
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

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderTransientError(`Apify network request failed: ${message}`);
    }
  }

  private async parseOrThrow(response: Response, action: string): Promise<unknown> {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const actorMemoryLimit = isActorMemoryLimit(body);
      const billingFailure = response.status === 402 || (response.status === 403 && isApifyBillingFailure(body));
      const message = actorMemoryLimit
        ? "Apify actor resource limit rejected the run."
        : `Apify ${action} failed: HTTP ${response.status}.`;
      throw new ApifyRequestError(message, response.status, actorMemoryLimit ? "actor_resource_limit" : billingFailure ? "billing" : undefined);
    }
    try {
      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderTransientError(`Apify ${action} returned invalid JSON: ${message}`);
    }
  }

  /**
   * Starts an Actor run asynchronously (does not block on completion —
   * §15 "do not keep a Vercel function open waiting for large actor runs").
   * `maxTotalChargeUsd` is Apify's own documented cost-guard query param.
   */
  async startActorRun(actorId: string, input: Record<string, unknown>, options: { maxTotalChargeUsd?: number; timeoutSecs?: number } = {}): Promise<ApifyRun> {
    const params = new URLSearchParams();
    if (options.maxTotalChargeUsd !== undefined) params.set("maxTotalChargeUsd", String(options.maxTotalChargeUsd));
    if (options.timeoutSecs !== undefined) params.set("timeout", String(options.timeoutSecs));
    const query = params.toString() ? `?${params.toString()}` : "";

    const response = await this.fetch(`${this.baseUrl}/acts/${encodeURIComponent(actorId)}/runs${query}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(input),
    });
    const body = (await this.parseOrThrow(response, "start run")) as { data: ApifyRun };
    return body.data;
  }

  async getActorRun(runId: string): Promise<ApifyRun> {
    const response = await this.fetch(`${this.baseUrl}/actor-runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const body = (await this.parseOrThrow(response, "get run status")) as { data: ApifyRun };
    return body.data;
  }

  async getAccountCostSnapshot(start: Date, end: Date): Promise<ApifyAccountCostSnapshot> {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new ProviderConfigurationError("Apify spend window is invalid.");
    }

    const pageSize = 1000;
    const runs: Array<Pick<ApifyRun, "id" | "status" | "startedAt" | "usageTotalUsd" | "options">> = [];
    for (let offset = 0; ; offset += pageSize) {
      const params = new URLSearchParams({
        startedAfter: start.toISOString(),
        startedBefore: end.toISOString(),
        desc: "1",
        limit: String(pageSize),
        offset: String(offset),
      });
      const response = await this.fetch(`${this.baseUrl}/actor-runs?${params.toString()}`, {
        method: "GET",
        headers: this.authHeaders(),
      });
      const body = await this.parseOrThrow(response, "list account runs") as {
        data?: { total?: unknown; items?: unknown };
      };
      const items = body.data?.items;
      if (!Array.isArray(items)) throw new ProviderTransientError("Apify account run list returned an invalid response.");
      for (const value of items) {
        if (!value || typeof value !== "object") throw new ProviderTransientError("Apify account run list returned an invalid run.");
        const run = value as Record<string, unknown>;
        if (typeof run.id !== "string" || typeof run.status !== "string" || typeof run.startedAt !== "string") {
          throw new ProviderTransientError("Apify account run list returned incomplete run data.");
        }
        const startedAt = Date.parse(run.startedAt);
        if (!Number.isFinite(startedAt)) throw new ProviderTransientError("Apify account run list returned an invalid start time.");
        if (startedAt >= start.getTime() && startedAt < end.getTime()) {
          runs.push({
            id: run.id,
            status: run.status as ApifyRunStatus,
            startedAt: run.startedAt,
            usageTotalUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
          });
        }
      }
      const total = body.data?.total;
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
        throw new ProviderTransientError("Apify account run list returned an invalid total.");
      }
      if (offset + items.length >= total || items.length === 0) break;
    }

    const activeParams = new URLSearchParams({
      startedBefore: end.toISOString(),
      status: "READY,RUNNING,TIMING-OUT,ABORTING",
      desc: "1",
      limit: String(pageSize),
      offset: "0",
    });
    const activeResponse = await this.fetch(`${this.baseUrl}/actor-runs?${activeParams.toString()}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const activeBody = await this.parseOrThrow(activeResponse, "list in-flight account runs") as {
      data?: { total?: unknown; items?: unknown };
    };
    const activeItems = activeBody.data?.items;
    if (!Array.isArray(activeItems) || typeof activeBody.data?.total !== "number" || activeBody.data.total > pageSize) {
      throw new ProviderTransientError("Apify in-flight account run list is incomplete; refusing new allocation.");
    }
    const runById = new Map(runs.map((run) => [run.id, run]));
    for (const value of activeItems) {
      if (!value || typeof value !== "object") throw new ProviderTransientError("Apify in-flight account run list returned an invalid run.");
      const run = value as Record<string, unknown>;
      if (typeof run.id !== "string" || typeof run.status !== "string" || typeof run.startedAt !== "string") {
        throw new ProviderTransientError("Apify in-flight account run list returned incomplete run data.");
      }
      const startedAt = Date.parse(run.startedAt);
      if (!Number.isFinite(startedAt) || startedAt >= end.getTime()) continue;
      if (!runById.has(run.id)) {
        runById.set(run.id, {
          id: run.id,
          status: run.status as ApifyRunStatus,
          startedAt: run.startedAt,
          usageTotalUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
        });
      }
    }
    runs.splice(0, runs.length, ...runById.values());

    let actualSpendUsd = 0;
    let reservedSpendUsd = 0;
    for (const listedRun of runs) {
      const run = ApifyClient.TERMINAL_STATUSES.includes(listedRun.status)
        ? listedRun
        : await this.getActorRun(listedRun.id);
      const actual = run.usageTotalUsd;
      if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0) {
        throw new ProviderTransientError("Apify account run cost is unavailable; refusing new allocation.");
      }
      const startedBeforeWindow = Date.parse(listedRun.startedAt) < start.getTime();
      if (!startedBeforeWindow) actualSpendUsd += actual;
      if (!ApifyClient.TERMINAL_STATUSES.includes(run.status)) {
        const ceiling = run.options?.maxTotalChargeUsd;
        if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
          throw new ProviderTransientError("An in-flight Apify account run has no verifiable charge ceiling; refusing new allocation.");
        }
        reservedSpendUsd += startedBeforeWindow ? ceiling : Math.max(0, ceiling - actual);
      }
    }

    return {
      dayStart: start.toISOString(),
      dayEnd: end.toISOString(),
      actualSpendUsd,
      reservedSpendUsd,
      committedSpendUsd: actualSpendUsd + reservedSpendUsd,
      runCount: runs.length,
      runIds: runs.map((run) => run.id),
    };
  }

  async startRun(actorId: string, input: Record<string, unknown>, options: { maxTotalChargeUsd?: number; timeoutSecs?: number } = {}): Promise<ApifyRun> {
    return this.startActorRun(actorId, input, options);
  }

  async getRun(runId: string): Promise<ApifyRun> {
    return this.getActorRun(runId);
  }

  async getDatasetItems(datasetId: string, options: { offset?: number; limit?: number } = {}): Promise<unknown[]> {
    const params = new URLSearchParams({ clean: "true" });
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.limit !== undefined) params.set("limit", String(options.limit));

    const response = await this.fetch(`${this.baseUrl}/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const actorMemoryLimit = isActorMemoryLimit(body);
      const message = actorMemoryLimit
        ? "Apify actor resource limit rejected the dataset request."
        : `Apify get dataset items failed: HTTP ${response.status}.`;
      throw new ApifyRequestError(message, response.status, actorMemoryLimit ? "actor_resource_limit" : undefined);
    }
    try {
      return (await response.json()) as unknown[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderTransientError(`Apify dataset response returned invalid JSON: ${message}`);
    }
  }

  static readonly TERMINAL_STATUSES: readonly ApifyRunStatus[] = ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"];

  /**
  * Corrective-phase bounded smoke helper. Production discovery must move to
  * persisted async lifecycle state before using this method for normal work.
   */
  async runAndWait(
    actorId: string,
    input: Record<string, unknown>,
    options: { maxTotalChargeUsd?: number; maxWaitMs?: number; pollIntervalMs?: number } = {},
  ): Promise<ApifyRun> {
    const maxWaitMs = options.maxWaitMs ?? 55_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    let run = await this.startActorRun(actorId, input, { maxTotalChargeUsd: options.maxTotalChargeUsd });
    const deadline = Date.now() + maxWaitMs;

    while (!ApifyClient.TERMINAL_STATUSES.includes(run.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      run = await this.getActorRun(run.id);
    }
    return run;
  }
}

function isApifyBillingFailure(body: string): boolean {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } };
    detail = [parsed.error?.type, parsed.error?.message].filter((value): value is string => typeof value === "string").join(" ");
  } catch {
    // Some Apify errors are returned as plain text.
  }
  return /billing|payment|credit|quota|usage[-_ ]limit|insufficient funds|insufficient credits|exhausted/i.test(detail);
}
