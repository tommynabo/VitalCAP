const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "msclkid", "ref"]);

/**
 * Canonicalize a URL for dedup/caching (Prompt 1 §1.3): forces a scheme,
 * lowercases scheme+host, drops default ports, strips tracking params and
 * fragments, and removes a trailing slash on non-root paths.
 */
export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  url.hash = "";

  const params = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix)) && !TRACKING_PARAM_NAMES.has(key.toLowerCase()),
  );
  params.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  let pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname === "" ? "/" : pathname;

  return url.toString();
}
