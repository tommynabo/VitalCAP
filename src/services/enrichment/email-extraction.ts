import { normalizeEmail } from "@/lib/normalization";

/**
 * Email extraction from a fetched page. Candidates retain source/context
 * metadata and pass through the same normalization and rejection guards.
 */

export interface ExtractedEmail {
  email: string;
  sourceUrl: string;
  sourceType: "website" | "serper_snippet";
  extractionMethod: "literal" | "deobfuscated";
  context: string;
  label: string;
  isGeneric: boolean;
}

export interface EmailExtractionResult {
  emails: ExtractedEmail[];
  rejectedFormat: number;
  duplicates: number;
  literalFound: number;
  deobfuscatedFound: number;
}

export interface EmailExtractionOptions {
  allowEncodedAndObfuscated?: boolean;
}

const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;
const VISIBLE_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_SOURCE_RE = /[a-z0-9._%+-]+(?:@|&commat;|&#(?:0*64|x0*40);)[a-z0-9-]+(?:(?:\.|&period;|&#(?:0*46|x0*2e);)[a-z0-9-]+)*(?:\.|&period;|&#(?:0*46|x0*2e);)[a-z]{2,}/gi;
const OBFUSCATED_EMAIL_RE = /[a-z0-9._%+-]+(?:\s*@\s*|\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*|\s*\{\s*at\s*\}\s*)[a-z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\.)\s*[a-z0-9-]+)*\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\.)\s*[a-z]{2,}/gi;

const ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js", "woff", "woff2"];
const BLOCKED_LOCAL_PARTS = ["noreply", "no-reply", "donotreply", "test", "example"];
const BLOCKED_DOMAINS = ["example.com", "example.es", "sentry.io", "wixpress.com", "godaddy.com"];
const GENERIC_LOCAL_PARTS = new Set([
  "info",
  "contacto",
  "contact",
  "hola",
  "ventas",
  "sales",
  "compras",
  "pedidos",
  "gerencia",
  "direccion",
  "administracion",
  "soporte",
  "support",
  "atencion",
  "tienda",
  "farmacia",
]);

function hasMalformedFormat(email: string): boolean {
  const [local, domain] = email.split("@");
  if (!local || !domain) return true;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return true;
  return domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function isFalsePositive(email: string): boolean {
  if (hasMalformedFormat(email)) return true;
  const [local, domain] = email.split("@");
  if (!local || !domain) return true;
  const domainExtension = domain.split(".").pop() ?? "";
  if (ASSET_EXTENSIONS.includes(domainExtension.toLowerCase())) return true;
  if (BLOCKED_LOCAL_PARTS.some((blocked) => local.toLowerCase().includes(blocked))) return true;
  if (BLOCKED_DOMAINS.includes(domain.toLowerCase())) return true;
  return false;
}

function contextAround(html: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(html.length, index + matchLength + 40);
  return html.slice(start, end).replace(/\s+/g, " ").trim();
}

function decodeEmailEntities(value: string): string {
  return value.replace(/&(?:commat|period);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const lower = entity.toLowerCase();
    if (lower === "&commat;") return "@";
    if (lower === "&period;") return ".";
    const encoded = entity.slice(2, -1).toLowerCase();
    const codePoint = encoded.startsWith("x")
      ? Number.parseInt(encoded.slice(1), 16)
      : Number.parseInt(encoded, 10);
    return codePoint === 64 ? "@" : codePoint === 46 ? "." : entity;
  });
}

function decodeMailtoTarget(value: string, allowEncodedAndObfuscated: boolean): { email: string; deobfuscated: boolean } {
  let decoded = value.split("?")[0] ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original target; normalization and format guards reject malformed values.
  }
  const withEntitiesDecoded = allowEncodedAndObfuscated ? decodeEmailEntities(decoded) : decoded;
  return { email: withEntitiesDecoded, deobfuscated: withEntitiesDecoded !== value };
}

function normalizeObfuscatedEmail(value: string): string {
  return value
    .replace(/\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}/gi, "@")
    .replace(/\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}/gi, ".")
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".");
}

export function extractCandidateEmailsWithDiagnostics(
  html: string,
  sourceUrl: string,
  sourceType: ExtractedEmail["sourceType"] = "website",
  options: EmailExtractionOptions = {},
): EmailExtractionResult {
  const found = new Map<string, ExtractedEmail>();
  const literalEmails = new Set<string>();
  const deobfuscatedEmails = new Set<string>();
  let rejectedFormat = 0;
  let duplicates = 0;

  const addCandidate = (rawEmail: string, index: number, matchLength: number, deobfuscated: boolean) => {
    const normalized = normalizeEmail(rawEmail);
    if (!normalized) {
      rejectedFormat += 1;
      return;
    }
    if (isFalsePositive(normalized)) {
      if (hasMalformedFormat(normalized)) rejectedFormat += 1;
      return;
    }
    (deobfuscated ? deobfuscatedEmails : literalEmails).add(normalized);
    if (found.has(normalized)) {
      duplicates += 1;
      return;
    }
    const local = normalized.split("@")[0] ?? "";
    found.set(normalized, {
      email: normalized,
      sourceUrl,
      sourceType,
      extractionMethod: deobfuscated ? "deobfuscated" : "literal",
      context: contextAround(html, index, matchLength),
      label: local,
      isGeneric: GENERIC_LOCAL_PARTS.has(local),
    });
  };

  for (const match of html.matchAll(MAILTO_RE)) {
    const decoded = decodeMailtoTarget(match[1] ?? "", options.allowEncodedAndObfuscated === true);
    addCandidate(decoded.email, match.index ?? 0, match[0].length, decoded.deobfuscated);
  }

  const visibleEmailPattern = options.allowEncodedAndObfuscated ? EMAIL_SOURCE_RE : VISIBLE_EMAIL_RE;
  for (const match of html.matchAll(visibleEmailPattern)) {
    const decoded = options.allowEncodedAndObfuscated ? decodeEmailEntities(match[0]) : match[0];
    addCandidate(decoded, match.index ?? 0, match[0].length, decoded !== match[0]);
  }

  if (options.allowEncodedAndObfuscated) {
    for (const match of html.matchAll(OBFUSCATED_EMAIL_RE)) {
      const normalizedRaw = normalizeEmail(match[0]);
      const normalizedObfuscated = normalizeEmail(normalizeObfuscatedEmail(match[0]));
      if (!normalizedObfuscated || normalizedObfuscated === normalizedRaw) continue;
      addCandidate(normalizedObfuscated, match.index ?? 0, match[0].length, true);
    }
  }

  return {
    emails: Array.from(found.values()),
    rejectedFormat,
    duplicates,
    literalFound: literalEmails.size,
    deobfuscatedFound: deobfuscatedEmails.size,
  };
}

export function extractCandidateEmails(
  html: string,
  sourceUrl: string,
  sourceType: ExtractedEmail["sourceType"] = "website",
): ExtractedEmail[] {
  return extractCandidateEmailsWithDiagnostics(html, sourceUrl, sourceType).emails;
}
