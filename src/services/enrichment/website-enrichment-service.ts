import { createHash } from "node:crypto";
import { normalizeDomain, normalizePhoneES } from "@/lib/normalization";
import type { WebsiteFetcher } from "@/domain/providers/types";
import { crawlWebsite, type CrawledPage } from "./website-crawler";
import { extractCandidateEmails } from "./email-extraction";
import { SafeFetchError } from "@/lib/security/safe-fetch";
import { createDeadlineSignal, DeadlineExceededError, raceWithAbort } from "@/lib/async/deadline";

export const WEBSITE_ENRICHMENT_BUDGET_MS = 90_000;

export interface WebsiteEvidenceFact {
  evidenceType: "email" | "phone" | "named_role" | "role_signal" | "business_signal" | "supplement_signal";
  value: string;
  normalizedValue?: string;
  snippet: string | null;
  sourceUrl: string;
  isGeneric?: boolean;
  isPersonalOrNamed?: boolean;
}

export interface WebsiteEnrichmentResult {
  status: "completed" | "no_website" | "timeout" | "transient_error" | "dns_failure" | "blocked_unsafe_url" | "http_error" | "parse_error";
  errorDetails?: string;
  pagesFetched: number;
  internalPagesFetched: number;
  emailCandidatesFound: number;
  contentHash: string | null;
  evidence: WebsiteEvidenceFact[];
}

export interface WebsiteEnrichmentContext {
  workspaceId: string;
  accountId: string;
  websiteUrl: string;
  signal?: AbortSignal;
}

const PHONE_RE = /(?:\+34|0034)?[ -]*(?:6|7|8|9)(?:[ -]*\d){8}/g;

const ICP_SIGNALS = [
  "farmacia",
  "parafarmacia",
  "herbolario",
  "herbolaria",
  // These remain useful product-assortment evidence, but are explicitly not
  // ICP evidence: the candidate processor only accepts the first four terms.
  "suplementos",
  "complementos alimenticios",
  "vitaminas",
  "nutrición deportiva",
  "bienestar",
];

const NAMED_ROLES = [
  "responsable de compras",
  "farmacéutico titular",
  "equipo farmacéutico",
  "propietario",
  "fundador",
  "director",
  "titular",
  "gerente",
];

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

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

function extractVisibleTextContext(html: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(html.length, index + matchLength + 60);
  return html.slice(start, end).replace(/\s+/g, " ").trim();
}

function stripBoilerplate(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function visibleEmailContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|head|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<([a-z][\w:-]*)\b[^>]*\shidden(?:\s|=|>)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*\baria-hidden\s*=\s*(["'])true\2)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*\bstyle\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*\2)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])mailto:([^"']+)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote: string, target: string, text: string) => `mailto:${target} ${text}`)
    .replace(/<[^>]+>/g, " ");
}

function extractPhones(text: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const facts: WebsiteEvidenceFact[] = [];
  const found = new Set<string>();

  for (const match of text.matchAll(PHONE_RE)) {
    const norm = normalizePhoneES(match[0]);
    if (norm && !found.has(norm)) {
      found.add(norm);
      facts.push({
        evidenceType: "phone",
        value: match[0].trim(),
        normalizedValue: norm,
        snippet: extractVisibleTextContext(text, match.index ?? 0, match[0].length),
        sourceUrl,
      });
    }
  }
  return facts;
}

function extractBusinessSignals(text: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const facts: WebsiteEvidenceFact[] = [];
  const lowerText = text.toLowerCase();
  
  for (const signal of ICP_SIGNALS) {
    const idx = lowerText.indexOf(signal);
    if (idx !== -1) {
      facts.push({
        evidenceType: ["suplementos", "complementos alimenticios", "vitaminas", "nutrición deportiva", "bienestar"].includes(signal)
          ? "supplement_signal"
          : "business_signal",
        value: signal,
        normalizedValue: signal,
        snippet: extractVisibleTextContext(text, idx, signal.length),
        sourceUrl,
      });
    }
  }
  return facts;
}

function extractNamedRoles(text: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const facts: WebsiteEvidenceFact[] = [];
  const lowerText = text.toLowerCase();
  
  for (const role of NAMED_ROLES) {
    let match;
    const regex = new RegExp(`([^.?!]*(?:${role})[^.?!]*)`, "gi");
    while ((match = regex.exec(text)) !== null) {
      const snippet = (match[1] || "").replace(/\s+/g, " ").trim();
      if (snippet.length > 5 && snippet.length < 150) {
        // Look for capitalized words that might be a name
        const nameMatch = snippet.match(/([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/);
        
        if (nameMatch) {
          facts.push({
            evidenceType: "named_role",
            value: role,
            normalizedValue: nameMatch[1],
            snippet: snippet,
            sourceUrl,
          });
        } else {
          facts.push({
            evidenceType: "role_signal",
            value: role,
            normalizedValue: role,
            snippet: snippet,
            sourceUrl,
          });
        }
      }
    }
  }
  return facts;
}

export class WebsiteEnrichmentService {
  constructor(
    private readonly fetcher: WebsiteFetcher,
    private readonly budgetMs = WEBSITE_ENRICHMENT_BUDGET_MS,
  ) {}

  async enrich(context: WebsiteEnrichmentContext): Promise<WebsiteEnrichmentResult> {
    if (!context.websiteUrl) {
      return { status: "no_website", pagesFetched: 0, internalPagesFetched: 0, emailCandidatesFound: 0, contentHash: null, evidence: [] };
    }

    let pages: CrawledPage[];
    const deadline = createDeadlineSignal(
      this.budgetMs,
      new DeadlineExceededError("WEBSITE_ENRICHMENT_TIMEOUT", `Website crawl exceeded ${this.budgetMs}ms.`),
      context.signal,
    );
    try {
      pages = await raceWithAbort(
        crawlWebsite(this.fetcher, context.websiteUrl, { signal: deadline.signal }),
        deadline.signal,
      );
    } catch (error: any) {
      if (error instanceof DeadlineExceededError || context.signal?.aborted) throw error;
      let status: WebsiteEnrichmentResult["status"] = "http_error";
      if (error instanceof SafeFetchError) {
        if (error.reason === "timeout") status = "timeout";
        else if (error.reason === "blocked_ip" || error.reason === "blocked_hostname") status = "blocked_unsafe_url";
        else if (error.reason === "http_server_error") status = "transient_error";
      } else if (networkErrorCode(error) === "ENOTFOUND") {
        status = "dns_failure";
      } else if (networkErrorCode(error) && TRANSIENT_NETWORK_CODES.has(networkErrorCode(error)!)) {
        status = "transient_error";
      }
      return { status, errorDetails: error.message, pagesFetched: 0, internalPagesFetched: 0, emailCandidatesFound: 0, contentHash: null, evidence: [] };
    } finally {
      deadline.dispose();
    }

    if (pages.length === 0) {
      return { status: "parse_error", pagesFetched: 0, internalPagesFetched: 0, emailCandidatesFound: 0, contentHash: null, evidence: [] };
    }

    const allContent = pages.map((p) => p.body).join("");
    const contentHash = createHash("sha256").update(allContent).digest("hex");
    
    const evidence: WebsiteEvidenceFact[] = [];
    const seenEvidence = new Set<string>();

    const addFact = (fact: WebsiteEvidenceFact) => {
      const key = `${fact.evidenceType}:${fact.value}`;
      if (!seenEvidence.has(key)) {
        seenEvidence.add(key);
        evidence.push(fact);
      }
    };

    for (const page of pages) {
      const emails = extractCandidateEmails(visibleEmailContent(page.body), page.url);
      for (const email of emails) {
        addFact({
          evidenceType: "email",
          value: email.email,
          normalizedValue: email.email,
          snippet: email.context,
          sourceUrl: page.url,
          isGeneric: email.isGeneric,
          isPersonalOrNamed: false, // Do not assume personhood just because it's not in the generic list
        });
      }

      const text = stripBoilerplate(page.body);
      const phones = extractPhones(text, page.url);
      phones.forEach(addFact);

      const signals = extractBusinessSignals(text, page.url);
      signals.forEach(addFact);

      const roles = extractNamedRoles(text, page.url);
      roles.forEach(addFact);
    }

    return {
      status: "completed",
      pagesFetched: pages.length,
      internalPagesFetched: Math.max(0, pages.length - 1),
      emailCandidatesFound: evidence.filter((fact) => fact.evidenceType === "email").length,
      contentHash,
      evidence,
    };
  }
}
