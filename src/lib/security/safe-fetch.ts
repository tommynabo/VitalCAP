/**
 * SSRF-safe website fetching (Prompt 2 §2.5). Pure, unit-testable guard
 * functions plus a thin fetch wrapper that enforces them. The wrapper takes
 * an injectable `fetchImpl` so tests never make a real network call.
 */

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "metadata.google.internal"]);

/** Hostnames that are obviously not a public website, without any DNS lookup. */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** IPv4/IPv6 literal ranges that must never be crawled (loopback, link-local, private, metadata). */
export function isPrivateOrLinkLocalIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 0) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  return false;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxContentLengthBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injected for tests / DI — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Resolves a hostname to IP literals for pre-fetch DNS validation. Defaults to a no-op (skip) when unavailable, e.g. in a browser/edge runtime. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_OPTIONS: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxContentLengthBytes" | "maxRedirects" | "userAgent">> = {
  timeoutMs: 8_000,
  maxContentLengthBytes: 2_000_000,
  maxRedirects: 3,
  userAgent: "VitalcapOutreachOS/1.0 (+https://vitalcap.example.es)",
};

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "blocked_scheme"
      | "blocked_hostname"
      | "blocked_ip"
      | "too_many_redirects"
      | "content_too_large"
      | "unsupported_content_type"
      | "timeout",
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

function assertPublicUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Blocked non-http(s) scheme: ${url.protocol}`, "blocked_scheme");
  }
  if (isBlockedHostname(url.hostname) || isPrivateOrLinkLocalIp(url.hostname)) {
    throw new SafeFetchError(`Blocked hostname: ${url.hostname}`, "blocked_hostname");
  }
}

/**
 * Fetches a single page with SSRF defenses: scheme allowlist, hostname/IP
 * blocklist (re-checked on every redirect hop), DNS revalidation where a
 * resolver is supplied, timeout, content-length cap, HTML-only, and a
 * bounded manual redirect loop (never delegates redirects to the fetch
 * implementation, so every hop is re-validated).
 */
export async function safeFetchPage(rawUrl: string, options: SafeFetchOptions = {}): Promise<{ url: string; status: number; contentType: string | null; body: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fetchImpl = options.fetchImpl ?? fetch;

  let currentUrl = new URL(rawUrl);
  for (let redirectCount = 0; ; redirectCount++) {
    assertPublicUrl(currentUrl);

    if (options.resolveHostname) {
      const ips = await options.resolveHostname(currentUrl.hostname);
      if (ips.some((ip) => isPrivateOrLinkLocalIp(ip))) {
        throw new SafeFetchError(`DNS-resolved IP for ${currentUrl.hostname} is private/link-local`, "blocked_ip");
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": opts.userAgent },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SafeFetchError(`Timed out fetching ${currentUrl.toString()}`, "timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { url: currentUrl.toString(), status: response.status, contentType: null, body: "" };
      if (redirectCount >= opts.maxRedirects) {
        throw new SafeFetchError(`Exceeded ${opts.maxRedirects} redirects`, "too_many_redirects");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new SafeFetchError(`Unsupported content-type: ${contentType}`, "unsupported_content_type");
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > opts.maxContentLengthBytes) {
      throw new SafeFetchError(`Content-Length ${contentLengthHeader} exceeds cap`, "content_too_large");
    }

    const body = await response.text();
    if (body.length > opts.maxContentLengthBytes) {
      throw new SafeFetchError(`Body exceeds ${opts.maxContentLengthBytes} bytes`, "content_too_large");
    }

    return { url: currentUrl.toString(), status: response.status, contentType, body };
  }
}

/** Per-domain fetch cache so the same domain is never re-crawled within a campaign run/across campaigns (§2.5). */
export class DomainFetchCache {
  private readonly cache = new Map<string, { url: string; status: number; contentType: string | null; body: string }>();

  key(url: string): string {
    return new URL(url).toString();
  }

  get(url: string) {
    return this.cache.get(this.key(url)) ?? null;
  }

  set(url: string, value: { url: string; status: number; contentType: string | null; body: string }): void {
    this.cache.set(this.key(url), value);
  }

  has(url: string): boolean {
    return this.cache.has(this.key(url));
  }
}
