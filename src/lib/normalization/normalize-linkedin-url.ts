import { normalizeUrl } from "./normalize-url";

const PROFILE_PATH = /^\/(in|company)\/([^/]+)/;

/**
 * Canonicalize a public LinkedIn profile/company URL for dedup (Prompt 1
 * §1.3): forces `https://www.linkedin.com/{in|company}/<handle>`, dropping
 * query params, locale prefixes and trailing slashes. Returns `null` for
 * anything that isn't a LinkedIn profile/company URL.
 */
export function normalizeLinkedInUrl(input: string | null | undefined): string | null {
  const normalized = normalizeUrl(input);
  if (!normalized) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;

  const match = PROFILE_PATH.exec(url.pathname);
  if (!match) return null;

  const [, kind, handle] = match;
  return `https://www.linkedin.com/${kind}/${handle}`;
}
