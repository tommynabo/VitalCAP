import type { WebsiteFetcher } from "@/domain/providers/types";
import { normalizeDomain } from "@/lib/normalization";

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
}

const DEFAULT_OPTIONS: WebsiteCrawlOptions = { maxPages: 6 };

function extractLinks(html: string, baseUrl: string, allowedDomain: string): string[] {
  const links: string[] = [];
  const hrefRe = /href=["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(hrefRe)) {
    const href = match[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      const normalizedResolved = normalizeDomain(resolved.hostname);
      if (allowedDomain && normalizedResolved === allowedDomain) links.push(resolved.toString());
    } catch {
      // ignore malformed hrefs (mailto:, tel:, javascript:, etc.)
    }
  }
  return links;
}

function isTargetPath(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return TARGET_PATH_KEYWORDS.some((keyword) => path.includes(keyword));
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
    home = await fetcher.fetchPage(rootUrl);
  } catch (error) {
    throw error;
  }
  
  visited.add(home.url);
  pages.push({ url: home.url, body: home.body });

  const allowedDomain = normalizeDomain(new URL(rootUrl).hostname);
  const candidateLinks = extractLinks(home.body, home.url, allowedDomain!).filter(isTargetPath).filter((url) => !visited.has(url));
  const uniqueCandidates = Array.from(new Set(candidateLinks));

  const maxConcurrency = 3;
  let index = 0;
  let attemptedPages = pages.length;
  
  const worker = async () => {
    while (index < uniqueCandidates.length && attemptedPages < opts.maxPages) {
      const link = uniqueCandidates[index++];
      if (!link) break;
      if (visited.has(link)) continue;
      visited.add(link);
      attemptedPages++;
      try {
        const page = await fetcher.fetchPage(link);
        if (pages.length < opts.maxPages) {
          pages.push({ url: page.url, body: page.body });
        }
      } catch {
        // if it failed, we could theoretically try another page by decrementing attemptedPages, 
        // but for safety we'll just let it count towards the limit.
      }
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrency, uniqueCandidates.length) }, () => worker());
  await Promise.all(workers);

  return pages;
}

