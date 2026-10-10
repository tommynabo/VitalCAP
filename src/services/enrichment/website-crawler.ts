import type { WebsiteFetcher } from "@/domain/providers/types";
import { normalizeDomain } from "@/lib/normalization";
import { SafeFetchError } from "@/lib/security/safe-fetch";

/**
 * Targeted internal-page crawl (Prompt 2 §2.4–2.5). Never crawls the whole
 * site — only paths matching a small, high-value keyword set (contact,
 * about, team, legal notice/privacy, pharmacy-owner pages), bounded by
 * `maxPages`, with URL dedup so the same page is never fetched twice.
 */

const TARGET_PATH_KEYWORDS = [
  "contact",
  "contacto",
  "about",
  "nosotros",
  "team",
  "equipo",
  "aviso-legal",
  "legal",
  "privacidad",
  "privacy",
  "titular",
  "propietario",
  "quienes-somos",
];

export interface CrawledPage {
  url: string;
  body: string;
}

export interface WebsiteCrawlOptions {
  maxPages: number;
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: WebsiteCrawlOptions = { maxPages: 6 };
const MAX_FETCH_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const PATH_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ["contact", 100],
  ["contacto", 100],
  ["about", 90],
  ["nosotros", 90],
  ["quienes-somos", 90],
  ["team", 80],
  ["equipo", 80],
  ["aviso-legal", 70],
  ["legal", 70],
  ["privacy", 60],
  ["privacidad", 60],
  ["impressum", 60],
];

const LINK_LABEL_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ["contact", 100],
  ["contacto", 100],
  ["contact us", 100],
  ["about", 90],
  ["nosotros", 90],
  ["quienes somos", 90],
  ["who we are", 90],
  ["team", 80],
  ["equipo", 80],
  ["legal", 70],
  ["aviso legal", 70],
  ["privacy", 60],
  ["privacidad", 60],
  ["impressum", 60],
];

function normalizeLinkLabel(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function targetPriority(url: string, label: string): number {
  const path = new URL(url).pathname.toLowerCase();
  const normalizedLabel = normalizeLinkLabel(label);
  const pathPriority = PATH_PRIORITIES.reduce(
    (highest, [keyword, priority]) => path.includes(keyword) ? Math.max(highest, priority) : highest,
    0,
  );
  const labelPriority = LINK_LABEL_PRIORITIES.reduce(
    (highest, [keyword, priority]) => normalizedLabel.includes(keyword) ? Math.max(highest, priority) : highest,
    0,
  );
  return Math.max(pathPriority, labelPriority);
}

function extractLinks(html: string, baseUrl: string, allowedDomain: string): Array<{ url: string; priority: number }> {
  const links: Array<{ url: string; priority: number }> = [];
  const anchorRe = /<a\b[^>]*?(?:\s)href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = match[2];
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if ((resolved.protocol !== "http:" && resolved.protocol !== "https:") || resolved.username || resolved.password) continue;
      const normalizedResolved = normalizeDomain(resolved.hostname);
      if (allowedDomain && normalizedResolved === allowedDomain) {
        const priority = targetPriority(resolved.toString(), match[3] ?? "");
        if (priority > 0) links.push({ url: resolved.toString(), priority });
      }
    } catch {
      // ignore malformed hrefs (mailto:, tel:, javascript:, etc.)
    }
  }
  return links;
}

function networkErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (candidate.cause && typeof candidate.cause === "object") {
    const causeCode = (candidate.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return null;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof SafeFetchError) {
    return error.reason === "timeout" || error.reason === "http_server_error";
  }
  const code = networkErrorCode(error);
  return code !== null && RETRYABLE_NETWORK_CODES.has(code);
}

async function fetchPageWithRetry(fetcher: WebsiteFetcher, url: string, signal?: AbortSignal): Promise<CrawledPage> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      signal?.throwIfAborted();
      const page = await fetcher.fetchPage(url, { signal });
      if (page.status >= 500) {
        throw new SafeFetchError(`HTTP ${page.status} fetching ${url}`, "http_server_error", page.status);
      }
      if (page.status >= 400) {
        throw new SafeFetchError(`HTTP ${page.status} fetching ${url}`, "http_client_error", page.status);
      }
      return { url: page.url, body: page.body };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (attempt >= MAX_FETCH_ATTEMPTS || !isRetryableFetchError(error)) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, RETRY_BACKOFF_MS * attempt);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  throw new Error("WEBSITE_FETCH_RETRY_EXHAUSTED");
}

/**
 * Crawls the homepage plus up to `maxPages` internal pages matching the
 * target-path keyword list. Homepage is always included (it is often the
 * only page with a footer email). URLs are deduped so a page already
 * fetched is never fetched twice, per §2.5.
 */
export async function crawlWebsite(fetcher: WebsiteFetcher, rootUrl: string, options: Partial<WebsiteCrawlOptions> = {}): Promise<CrawledPage[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];

  let home: CrawledPage;
  try {
    home = await fetchPageWithRetry(fetcher, rootUrl, opts.signal);
  } catch (error) {
    throw error;
  }
  
  visited.add(home.url);
  pages.push({ url: home.url, body: home.body });

  const allowedDomain = normalizeDomain(new URL(rootUrl).hostname);
  const candidateLinks = extractLinks(home.body, home.url, allowedDomain!).filter(({ url }) => !visited.has(url));
  const uniqueCandidates = Array.from(
    new Map(candidateLinks.map((link) => [link.url, link])).values(),
  ).sort((left, right) => right.priority - left.priority);

  const maxConcurrency = 3;
  let index = 0;
  let attemptedPages = pages.length;
  
  const worker = async () => {
    while (index < uniqueCandidates.length && attemptedPages < opts.maxPages) {
      opts.signal?.throwIfAborted();
      const candidate = uniqueCandidates[index++];
      if (!candidate) break;
      if (visited.has(candidate.url)) continue;
      visited.add(candidate.url);
      attemptedPages++;
      try {
        const page = await fetchPageWithRetry(fetcher, candidate.url, opts.signal);
        if (pages.length < opts.maxPages) {
          pages.push(page);
        }
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? error;
        // if it failed, we could theoretically try another page by decrementing attemptedPages, 
        // but for safety we'll just let it count towards the limit.
      }
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrency, uniqueCandidates.length) }, () => worker());
  await Promise.all(workers);

  return pages;
}

