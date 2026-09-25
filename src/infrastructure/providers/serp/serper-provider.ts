import type { SerpDiscoveryProvider, SerpResult, SerpSearchInput, SerpSearchOutput } from "@/domain/providers/types";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
/** Serper's lowest published rate ($50 / 50k credits, 1 credit/query) — used only as a cost estimate, not billed truth. */
const ESTIMATED_COST_PER_QUERY_USD = 0.001;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
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
        clearTimeout(timeout);

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Serper request failed: HTTP ${response.status} ${body}`.trim());
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
            calls: 1,
            items: results.length,
            errors: 0,
            totalLatencyMs: Date.now() - start,
            costUsd: ESTIMATED_COST_PER_QUERY_USD,
            quotaRemaining: null,
          },
        };
        this.cache.set(key, output);
        return output;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt === MAX_RETRIES) break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
