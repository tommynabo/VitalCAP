import { normalizeEmail } from "@/lib/normalization";

/**
 * Email extraction from a fetched page (Prompt 2 §2.6). Extracts *every*
 * candidate email — not just the first — with source/context metadata so
 * downstream priority scoring and verification can each make their own
 * call. Deliberately does not auto-discard `info@`: it is valuable for
 * pharmacies (§2.6).
 */

export interface ExtractedEmail {
  email: string;
  sourceUrl: string;
  sourceType: "website" | "serper_snippet";
  /** Short surrounding text snippet, for a human reviewing why this email was picked up. */
  context: string;
  /** Local-part-derived label, e.g. "info", "compras", "maria.garcia". */
  label: string;
  isGeneric: boolean;
}

export interface EmailExtractionResult {
  emails: ExtractedEmail[];
  rejectedFormat: number;
  duplicates: number;
}

const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;
// Matches word@word.ext shapes anywhere in visible text, not just mailto links.
const VISIBLE_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

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

export function extractCandidateEmailsWithDiagnostics(
  html: string,
  sourceUrl: string,
  sourceType: ExtractedEmail["sourceType"] = "website",
): EmailExtractionResult {
  const found = new Map<string, ExtractedEmail>();
  let rejectedFormat = 0;
  let duplicates = 0;

  const addCandidate = (rawEmail: string, index: number, matchLength: number) => {
    const normalized = normalizeEmail(rawEmail);
    if (!normalized) {
      rejectedFormat += 1;
      return;
    }
    if (isFalsePositive(normalized)) {
      if (hasMalformedFormat(normalized)) rejectedFormat += 1;
      return;
    }
    if (found.has(normalized)) {
      duplicates += 1;
      return;
    }
    const local = normalized.split("@")[0] ?? "";
    found.set(normalized, {
      email: normalized,
      sourceUrl,
      sourceType,
      context: contextAround(html, index, matchLength),
      label: local,
      isGeneric: GENERIC_LOCAL_PARTS.has(local),
    });
  };

  for (const match of html.matchAll(MAILTO_RE)) {
    const raw = decodeURIComponent(match[1] ?? "").split("?")[0] ?? "";
    addCandidate(raw, match.index ?? 0, match[0].length);
  }

  for (const match of html.matchAll(VISIBLE_EMAIL_RE)) {
    addCandidate(match[0], match.index ?? 0, match[0].length);
  }

  return { emails: Array.from(found.values()), rejectedFormat, duplicates };
}

export function extractCandidateEmails(
  html: string,
  sourceUrl: string,
  sourceType: ExtractedEmail["sourceType"] = "website",
): ExtractedEmail[] {
  return extractCandidateEmailsWithDiagnostics(html, sourceUrl, sourceType).emails;
}
