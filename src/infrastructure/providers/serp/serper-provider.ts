import type { SerpDiscoveryProvider, SerpResult, SerpSearchInput, SerpSearchOutput } from "@/domain/providers/types";
import { ProviderFailureError } from "@/domain/providers/errors";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
/** Serper's lowest published rate ($50 / 50k credits, 1 credit/query) — used only as a cost estimate, not billed truth. */
export const SERPER_ESTIMATED_COST_PER_QUERY_USD = 0.001;
export const SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD = 0.025;
const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TRANSIENT_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 30_000;

export type SerperFailureKind = "billing" | "authentication" | "configuration" | "transient" | "rate_limit" | "timeout" | "unknown" | "safety";

export class SerperRequestError extends ProviderFailureError {
  constructor(
    message: string,
    kind: SerperFailureKind,
    retryAt: Date | null,
    readonly retryAfterMs = 0,
    readonly httpAttempts = 1,
    readonly estimatedCostUsd = httpAttempts * SERPER_ESTIMATED_COST_PER_QUERY_USD,
  ) {
    super(message, kind, retryAt);
    this.name = "SerperRequestError";
  }
}

function parseRetryAfter(response: Response, now = Date.now()): number {
  const value = response.headers.get("Retry-After");
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number.isFinite(delay) ? delay : 0));
}

function classifyHttpFailure(status: number, body: string, response: Response): SerperRequestError {
  const message = `Serper request failed: HTTP ${status} ${body}`.trim();
  if (status === 400 && /not enough credits/i.test(body)) return new SerperRequestError(message, "billing", null);
  if (status === 401) return new SerperRequestError(message, "authentication", null);
  if (status === 403) return new SerperRequestError(message, "configuration", null);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response);
    return new SerperRequestError(message, "rate_limit", new Date(Date.now() + Math.max(retryAfterMs, 60_000)), retryAfterMs);
  }
  if (status >= 500) return new SerperRequestError(message, "transient", new Date(Date.now() + 2 * 60_000));
  if (status >= 400) return new SerperRequestError(message, "configuration", null);
  return new SerperRequestError(message, "unknown", null);
}

function retryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof SerperRequestError)) return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  if (error.kind === "billing" || error.kind === "authentication" || error.kind === "configuration" || error.kind === "safety") return null;
  if (error.kind === "rate_limit") return Math.max(error.retryAfterMs, 1_000 * 2 ** attempt);
  if (error.kind === "transient" || error.kind === "timeout" || error.kind === "unknown") return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return null;
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
}

export interface SerperDiscoveryProviderConfig {
  apiKey: string;
  country?: string;
  language?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelay?: (delayMs: number) => Promise<void>;
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Real Serper.dev-backed `SerpDiscoveryProvider` (Prompt 7 §16–§18). Used
 * for both `google_serp` (business/category queries) and `linkedin_owner`
 * (public `site:linkedin.com/in` searches only — never authenticated
 * LinkedIn scraping). Endpoint/header shape (`POST
 * https://google.serper.dev/search`, `X-API-KEY` header, `gl`/`hl`/`num`
 * body params) is Serper's own documented Google Search API contract.
 * Includes retry-with-backoff on transient failures, a bounded timeout, and
 * an in-process response cache so identical queries are never re-billed
 * within the same runtime (§17 "cache identical queries").
 */
export class SerperDiscoveryProvider implements SerpDiscoveryProvider {
  readonly providerName = "serper";
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, SerpSearchOutput>();

  constructor(private readonly config: SerperDiscoveryProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private cacheKey(input: SerpSearchInput): string {
    return `${input.query}|${input.maxResults}|${this.config.country ?? "es"}|${this.config.language ?? "es"}`;
  }

  async search(input: SerpSearchInput): Promise<SerpSearchOutput> {
    const key = this.cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, usage: { ...cached.usage, calls: 0, costUsd: 0 } };
    }

    const start = Date.now();
    let lastError: unknown;
    let httpAttempts = 0;
    const maxRetries = Math.min(input.maxRetries ?? MAX_TRANSIENT_RETRIES, MAX_TRANSIENT_RETRIES);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const abortFromParent = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", abortFromParent, { once: true });
      if (input.signal?.aborted) abortFromParent();
      try {
        input.signal?.throwIfAborted();
        httpAttempts += 1;
        const response = await this.fetchImpl(SERPER_SEARCH_URL, {
          method: "POST",
          headers: {
            "X-API-KEY": this.config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: input.query,
            gl: this.config.country ?? "es",
            hl: this.config.language ?? "es",
            num: input.maxResults,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw classifyHttpFailure(response.status, body, response);
        }

        const data = (await response.json()) as SerperSearchResponse;
        const results: SerpResult[] = (data.organic ?? []).slice(0, input.maxResults).map((r) => ({
          title: r.title ?? "",
          url: r.link ?? "",
          snippet: r.snippet ?? "",
          domain: r.link ? domainFromUrl(r.link) : null,
        }));

        const output: SerpSearchOutput = {
          results,
          usage: {
            calls: httpAttempts,
            items: results.length,
            errors: 0,
            totalLatencyMs: Date.now() - start,
            costUsd: httpAttempts * SERPER_ESTIMATED_COST_PER_QUERY_USD,
            quotaRemaining: null,
          },
        };
        this.cache.set(key, output);
        return output;
      } catch (error) {
        if (input.signal?.aborted) {
          const reason = input.signal.reason ?? error;
          if (reason instanceof Error) Object.assign(reason, { httpAttempts, estimatedCostUsd: httpAttempts * SERPER_ESTIMATED_COST_PER_QUERY_USD });
          throw reason;
        }
        const classifiedError = error instanceof Error && error.name === "AbortError"
          ? new SerperRequestError("Serper request timed out.", "timeout", new Date(Date.now() + 2 * 60_000))
          : error;
        const errorKind: SerperFailureKind = classifiedError instanceof SerperRequestError ? classifiedError.kind : "unknown";
        const retryAt = classifiedError instanceof SerperRequestError ? classifiedError.retryAt : null;
        const retryAfterMs = classifiedError instanceof SerperRequestError ? classifiedError.retryAfterMs : 0;
        lastError = new SerperRequestError(
          classifiedError instanceof Error ? classifiedError.message : String(classifiedError),
          errorKind,
          retryAt,
          retryAfterMs,
          httpAttempts,
          ["billing", "authentication", "configuration"].includes(errorKind)
            ? 0
            : httpAttempts * SERPER_ESTIMATED_COST_PER_QUERY_USD,
        );
        const delayMs = retryDelay(lastError, attempt);
        if (attempt === maxRetries || delayMs === null) break;
        await (this.config.retryDelay ?? waitForRetry)(delayMs);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abortFromParent);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
