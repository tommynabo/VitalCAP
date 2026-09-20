/**
 * Provider adapter contracts (Prompt 2 §2.1, §2.7, §2.13). Pure interfaces
 * only — no framework or infrastructure imports, no hard-coded provider
 * choice. Concrete adapters (real or mock) live in `infrastructure/providers/*`
 * and implement these shapes; services depend on the interface, never the
 * concrete adapter, per `docs/ARCHITECTURE.md` layering rule.
 */

export interface ProviderUsageStats {
  calls: number;
  items: number;
  errors: number;
  totalLatencyMs: number;
  costUsd: number;
  quotaRemaining: number | null;
}

export function emptyProviderUsageStats(): ProviderUsageStats {
  return { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null };
}

export interface MapsPlaceResult {
  externalPlaceId: string;
  name: string;
  category: string | null;
  address: string | null;
  postalCode: string | null;
  province: string | null;
  city: string | null;
  countryCode: string | null;
  websiteUrl: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  sourceUrl: string | null;
}

export interface MapsSearchInput {
  query: string;
  geography: string;
  pageToken: string | null;
}

export interface MapsSearchOutput {
  results: MapsPlaceResult[];
  nextPageToken: string | null;
  usage: ProviderUsageStats;
}

export interface MapsDiscoveryProvider {
  readonly providerName: string;
  search(input: MapsSearchInput): Promise<MapsSearchOutput>;
}

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
  domain: string | null;
}

export interface SerpSearchInput {
  query: string;
  maxResults: number;
}

export interface SerpSearchOutput {
  results: SerpResult[];
  usage: ProviderUsageStats;
}

export interface SerpDiscoveryProvider {
  readonly providerName: string;
  search(input: SerpSearchInput): Promise<SerpSearchOutput>;
}

export type EmailVerificationCode = "valid" | "catch_all" | "risky" | "invalid" | "unknown" | "disposable";

export interface EmailVerificationOutcome {
  email: string;
  code: EmailVerificationCode;
  providerRawCode: string;
  costUsd: number;
  checkedAt: string;
}

export interface EmailVerificationProvider {
  readonly providerName: string;
  /** Supports batching per §2.7 — always accepts an array, even for a single email. */
  verifyBatch(emails: readonly string[]): Promise<{ outcomes: EmailVerificationOutcome[]; usage: ProviderUsageStats }>;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

export interface WebsiteFetcher {
  fetchPage(url: string): Promise<FetchedPage>;
}
