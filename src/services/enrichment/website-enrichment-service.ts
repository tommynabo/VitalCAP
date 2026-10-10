import { createHash } from "node:crypto";
import { normalizeDomain, normalizePhoneES } from "@/lib/normalization";
import { provinceForPostalCode } from "@/lib/geography/spain-provinces";
import type { WebsiteFetcher } from "@/domain/providers/types";
import { crawlWebsite, type CrawledPage } from "./website-crawler";
import { extractCandidateEmails } from "./email-extraction";
import { SafeFetchError } from "@/lib/security/safe-fetch";
import { createDeadlineSignal, DeadlineExceededError, raceWithAbort } from "@/lib/async/deadline";

export const WEBSITE_ENRICHMENT_BUDGET_MS = 90_000;

export interface WebsiteEvidenceFact {
  evidenceType:
    | "email"
    | "phone"
    | "named_role"
    | "role_signal"
    | "business_signal"
    | "supplement_signal"
    | "location_country"
    | "location_postal_code"
    | "location_latitude"
    | "location_longitude";
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

function structuredCountryCode(value: unknown): { value: string; normalizedValue: string } | null {
  const rawValue = typeof value === "string"
    ? value.trim()
    : value && typeof value === "object" && "name" in value && typeof value.name === "string"
      ? value.name.trim()
      : "";
  if (!rawValue) return null;

  const normalizedCountry = rawValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (["es", "esp", "spain", "espana"].includes(normalizedCountry)) {
    return { value: rawValue, normalizedValue: "ES" };
  }
  return { value: rawValue, normalizedValue: rawValue.toUpperCase() };
}

function structuredNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

interface HtmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: (HtmlElement | string)[];
}

const VOID_HTML_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HIDDEN_HTML_TAGS = new Set(["head", "script", "style", "noscript", "template", "svg"]);
const LOCATION_BLOCK_TAGS = new Set(["address", "footer", "p", "li", "td", "th"]);
const MAX_HTML_PARSE_LENGTH = 1_000_000;
const MAX_HTML_NODES = 10_000;

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|nbsp|quot|apos|lt|gt);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "nbsp") return " ";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    const numeric = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function parseHtmlElements(html: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attributes: {}, children: [] };
  const stack = [root];
  let nodeCount = 0;
  const parseableHtml = html.slice(0, MAX_HTML_PARSE_LENGTH)
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const tokens = parseableHtml.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+|</gi) ?? [];

  for (const token of tokens) {
    if (token.startsWith("<!--") || /^<!/i.test(token)) continue;
    const closing = token.match(/^<\/\s*([a-z][\w:-]*)\s*>$/i);
    if (closing) {
      const tag = closing[1]!.toLowerCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index]!.tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const opening = token.match(/^<([a-z][\w:-]*)\b([^>]*)>$/i);
    if (!opening) {
      if (token && nodeCount < MAX_HTML_NODES) {
        stack[stack.length - 1]!.children.push(decodeHtmlEntities(token));
        nodeCount++;
      }
      continue;
    }

    const tag = opening[1]!.toLowerCase();
    if (["address", "footer", "p", "li", "td", "th"].includes(tag)) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index]!.tag === tag) {
          stack.length = index;
          break;
        }
      }
    }
    const attributeText = opening[2] ?? "";
    const attributes: Record<string, string> = {};
    for (const match of attributeText.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[match[1]!.toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    const element: HtmlElement = { tag, attributes, children: [] };
    stack[stack.length - 1]!.children.push(element);
    nodeCount++;
    if (!VOID_HTML_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(element);
    if (nodeCount >= MAX_HTML_NODES) break;
  }

  return root;
}

function elementText(element: HtmlElement, visibleOnly = false, depth = 0): string {
  if (depth > 100) return "";
  if (visibleOnly) {
    const { attributes, tag } = element;
    if (HIDDEN_HTML_TAGS.has(tag) || "hidden" in attributes || attributes["aria-hidden"]?.toLowerCase() === "true") return "";
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes.style ?? "")) return "";
  }
  return element.children.map((child) => typeof child === "string"
    ? child
    : elementText(child, visibleOnly, depth + 1)).join(" ").replace(/\s+/g, " ").trim();
}

function descendants(element: HtmlElement): HtmlElement[] {
  const result: HtmlElement[] = [];
  const pending = [...element.children].reverse();
  while (pending.length > 0 && result.length < MAX_HTML_NODES) {
    const current = pending.pop();
    if (!current || typeof current === "string") continue;
    result.push(current);
    pending.push(...current.children.filter((child): child is HtmlElement => typeof child !== "string").reverse());
  }
  return result;
}

function itemValue(element: HtmlElement): string {
  for (const attribute of ["content", "datetime", "value", "href", "src"]) {
    const value = element.attributes[attribute]?.trim();
    if (value) return value;
  }
  if ("itemscope" in element.attributes) {
    const name = descendants(element).find((child) => (child.attributes.itemprop ?? "").toLowerCase().split(/\s+/).includes("name"));
    if (name) return itemValue(name);
  }
  return elementText(element);
}

function extractMicrodataLocationFacts(html: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const root = parseHtmlElements(html);
  const facts: WebsiteEvidenceFact[] = [];
  const seen = new Set<string>();
  const addFact = (evidenceType: WebsiteEvidenceFact["evidenceType"], value: string, normalizedValue = value) => {
    const key = `${evidenceType}:${normalizedValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ evidenceType, value, normalizedValue, snippet: "Schema.org microdata location", sourceUrl });
  };
  const scopes = descendants(root).filter((element) => "itemscope" in element.attributes);

  for (const scope of scopes) {
    const types = (scope.attributes.itemtype ?? "").split(/\s+/).map((type) => type.split(/[\/#]/).at(-1)?.toLowerCase());
    const isPostalAddress = types.includes("postaladdress");
    const isGeoCoordinates = types.includes("geocoordinates");
    if (!isPostalAddress && !isGeoCoordinates) continue;

    const properties = new Map<string, string[]>();
    const pending = [...scope.children].reverse();
    let visited = 0;
    while (pending.length > 0 && visited < MAX_HTML_NODES) {
      const child = pending.pop();
      if (!child || typeof child === "string") continue;
      visited++;
      for (const property of (child.attributes.itemprop ?? "").toLowerCase().split(/\s+/).filter(Boolean)) {
        const value = itemValue(child);
        if (value) properties.set(property, [...(properties.get(property) ?? []), value]);
      }
      if (!("itemscope" in child.attributes)) {
        pending.push(...child.children.filter((item): item is HtmlElement => typeof item !== "string").reverse());
      }
    }

    if (isPostalAddress) {
      const country = structuredCountryCode(properties.get("addresscountry")?.[0]);
      if (country) addFact("location_country", country.value, country.normalizedValue);
      const postalCode = properties.get("postalcode")?.[0]?.trim();
      if (postalCode && provinceForPostalCode(postalCode)) addFact("location_postal_code", postalCode);
    }

    if (isGeoCoordinates) {
      const latitude = structuredNumber(properties.get("latitude")?.[0]);
      const longitude = structuredNumber(properties.get("longitude")?.[0]);
      if (latitude !== null && longitude !== null) {
        addFact("location_latitude", String(latitude));
        addFact("location_longitude", String(longitude));
      }
    }
  }

  return facts;
}

const SPANISH_STREET_ADDRESS_RE = /\b(?:calle|carrer|carrera|avenida|avda\.?|plaza|paseo|via|ronda|camino|carretera|callejon|c\.|c\/|av\.)\s+[\p{L}\d.'’/-]+(?:\s+[\p{L}\d.'’/-]+){0,4}\s+\d{1,4}[a-z]?\b/iu;

function extractVisibleAddressPostalFacts(html: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const root = parseHtmlElements(html);
  const facts: WebsiteEvidenceFact[] = [];
  const seen = new Set<string>();
  for (const element of descendants(root)) {
    const semanticLabel = `${element.attributes.class ?? ""} ${element.attributes.id ?? ""}`;
    const isLocationBlock = LOCATION_BLOCK_TAGS.has(element.tag)
      || ((element.tag === "div" || element.tag === "section" || element.tag === "article")
        && /address|direccion|direcci[oó]n|contact|location|postal/i.test(semanticLabel));
    if (!isLocationBlock) continue;
    const text = elementText(element, true);
    if (text.length === 0 || text.length > 500 || !SPANISH_STREET_ADDRESS_RE.test(text)) continue;
    for (const match of text.matchAll(/\b\d{5}\b/g)) {
      const postalCode = match[0];
      if (!provinceForPostalCode(postalCode) || seen.has(postalCode)) continue;
      seen.add(postalCode);
      facts.push({
        evidenceType: "location_postal_code",
        value: postalCode,
        normalizedValue: postalCode,
        snippet: "Visible Spanish postal address block",
        sourceUrl,
      });
    }
  }
  return facts;
}

function extractStructuredLocationFacts(html: string, sourceUrl: string): WebsiteEvidenceFact[] {
  const facts: WebsiteEvidenceFact[] = [];
  const factKeys = new Set<string>();
  const addFact = (evidenceType: WebsiteEvidenceFact["evidenceType"], value: string, normalizedValue = value) => {
    const key = `${evidenceType}:${normalizedValue}`;
    if (factKeys.has(key)) return;
    factKeys.add(key);
    facts.push({ evidenceType, value, normalizedValue, snippet: "Structured JSON-LD location data", sourceUrl });
  };

  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = script[1] ?? "";
    const type = attributes.match(/\btype\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i)?.[2]
      ?? attributes.match(/\btype\s*=\s*([^\s>]+)/i)?.[1]
      ?? "";
    if (!/^application\/ld\+json(?:\s*;|$)/i.test(type.trim())) continue;

    const json = script[2] ?? "";
    if (json.length > 256_000) continue;
    let root: unknown;
    try {
      root = JSON.parse(json);
    } catch {
      continue;
    }

    const pending: unknown[] = [root];
    let visited = 0;
    while (pending.length > 0 && visited < 5_000) {
      const current = pending.pop();
      if (!current || typeof current !== "object") continue;
      visited++;
      if (Array.isArray(current)) {
        for (const child of current) {
          if (pending.length >= 5_000) break;
          pending.push(child);
        }
        continue;
      }

      const node = current as Record<string, unknown>;
      const rawTypes = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      const types = rawTypes
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.split(/[\/#]/).at(-1)?.toLowerCase());
      const isLocationEntity = types.some((item) => item === "localbusiness" || item === "organization");
      const isPostalAddress = types.includes("postaladdress");

      if (isLocationEntity || isPostalAddress) {
        const address = node.address && typeof node.address === "object"
          ? node.address as Record<string, unknown>
          : null;
        const country = structuredCountryCode(node.addressCountry ?? address?.addressCountry);
        if (country) addFact("location_country", country.value, country.normalizedValue);

        const postalCode = node.postalCode ?? address?.postalCode;
        if (typeof postalCode === "string" && provinceForPostalCode(postalCode)) {
          addFact("location_postal_code", postalCode.trim());
        }
      }

      let geo = node.geo;
      if (!geo && types.includes("geocoordinates")) geo = node;
      if (geo && typeof geo === "object") {
        const coordinates = geo as Record<string, unknown>;
        const latitude = structuredNumber(coordinates.latitude);
        const longitude = structuredNumber(coordinates.longitude);
        if (latitude !== null && longitude !== null) {
          addFact("location_latitude", String(latitude));
          addFact("location_longitude", String(longitude));
        }
      }

      for (const child of Object.values(node)) {
        if (pending.length >= 5_000) break;
        pending.push(child);
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
      const provenanceKey = fact.evidenceType.startsWith("location_") ? `:${fact.sourceUrl}` : "";
      const key = `${fact.evidenceType}:${fact.value}${provenanceKey}`;
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

      const structuredLocation = extractStructuredLocationFacts(page.body, page.url);
      structuredLocation.forEach(addFact);

      const microdataLocation = extractMicrodataLocationFacts(page.body, page.url);
      microdataLocation.forEach(addFact);

      const visibleAddressLocation = extractVisibleAddressPostalFacts(page.body, page.url);
      visibleAddressLocation.forEach(addFact);
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
