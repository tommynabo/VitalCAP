import { createHash } from "node:crypto";
import { normalizeDomain, normalizePhoneES } from "@/lib/normalization";
import type { WebsiteFetcher } from "@/domain/providers/types";
import { crawlWebsite, type CrawledPage } from "./website-crawler";
import { extractCandidateEmails } from "./email-extraction";
import { SafeFetchError } from "@/lib/security/safe-fetch";

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
  status: "completed" | "no_website" | "timeout" | "dns_failure" | "blocked_unsafe_url" | "http_error" | "parse_error";
  errorDetails?: string;
  pagesFetched: number;
  contentHash: string | null;
  evidence: WebsiteEvidenceFact[];
}

export interface WebsiteEnrichmentContext {
  workspaceId: string;
  accountId: string;
  websiteUrl: string;
}

const PHONE_RE = /(?:\+34|0034)?[ -]*(?:6|7|8|9)(?:[ -]*\d){8}/g;

const ICP_SIGNALS = [
  "farmacia",
  "parafarmacia",
  "herbolario",
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
      const type = (signal === "suplementos" || signal === "complementos alimenticios" || signal === "vitaminas") 
        ? "supplement_signal" 
        : "business_signal";
      facts.push({
        evidenceType: type,
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
  constructor(private readonly fetcher: WebsiteFetcher) {}

  async enrich(context: WebsiteEnrichmentContext): Promise<WebsiteEnrichmentResult> {
    if (!context.websiteUrl) {
      return { status: "no_website", pagesFetched: 0, contentHash: null, evidence: [] };
    }

    let pages: CrawledPage[];
    try {
      pages = await crawlWebsite(this.fetcher, context.websiteUrl);
    } catch (error: any) {
      let status: WebsiteEnrichmentResult["status"] = "http_error";
      if (error instanceof SafeFetchError) {
        if (error.reason === "timeout") status = "timeout";
        else if (error.reason === "blocked_ip" || error.reason === "blocked_hostname") status = "blocked_unsafe_url";
      } else if (error.code === "ENOTFOUND") {
        status = "dns_failure";
      }
      return { status, errorDetails: error.message, pagesFetched: 0, contentHash: null, evidence: [] };
    }

    if (pages.length === 0) {
      return { status: "parse_error", pagesFetched: 0, contentHash: null, evidence: [] };
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
      const emails = extractCandidateEmails(page.body, page.url);
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
      contentHash,
      evidence,
    };
  }
}
