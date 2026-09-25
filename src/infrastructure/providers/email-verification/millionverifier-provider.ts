import type { EmailVerificationCode, EmailVerificationOutcome, EmailVerificationProvider, ProviderUsageStats } from "@/domain/providers/types";

const MILLIONVERIFIER_BASE_URL = "https://api.millionverifier.com/api/v3/";
/** Approximate per-email cost; adjust to your actual MillionVerifier plan rate. Not a billed-truth figure. */
const ESTIMATED_COST_PER_EMAIL_USD = 0.004;
const DEFAULT_TIMEOUT_SECS = 10;
/** Bounded concurrency for the real-time single-email endpoint (no true batch endpoint exists for real-time verification). */
const CONCURRENCY = 5;

interface MillionVerifierResponse {
  email?: string;
  quality?: string;
  result?: string;
  resultcode?: number;
  subresult?: string;
  free?: boolean;
  role?: boolean;
  credits?: number;
  error?: string;
}

/**
 * Maps MillionVerifier's `result`/`quality` fields to our domain codes. Per
 * §20 "a provider outage must never become `valid`" — any unexpected/error
 * response maps to `unknown`, never `valid`. `quality: "risky"` on an
 * otherwise-ok result maps to our `risky` code rather than `valid`.
 */
function mapToCode(data: MillionVerifierResponse): EmailVerificationCode {
  if (data.error) return "unknown";
  switch (data.result) {
    case "ok":
      return data.quality === "risky" ? "risky" : "valid";
    case "catch_all":
      return "catch_all";
    case "disposable":
      return "disposable";
    case "invalid":
      return "invalid";
    default:
      return "unknown";
  }
}

export interface MillionVerifierProviderConfig {
  apiKey: string;
  timeoutSecs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

async function verifyOne(email: string, config: MillionVerifierProviderConfig): Promise<EmailVerificationOutcome> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = new URL(MILLIONVERIFIER_BASE_URL);
  url.searchParams.set("api", config.apiKey);
  url.searchParams.set("email", email);
  url.searchParams.set("timeout", String(config.timeoutSecs ?? DEFAULT_TIMEOUT_SECS));
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetchImpl(url.toString(), { method: "GET" });
    if (!response.ok) {
      return { email, code: "unknown", providerRawCode: `http_${response.status}`, costUsd: 0, checkedAt };
    }
    const data = (await response.json()) as MillionVerifierResponse;
    if (data.error) {
      // Provider-reported error (e.g. insufficient credits, invalid key) must never resolve to "valid".
      return { email, code: "unknown", providerRawCode: data.error, costUsd: 0, checkedAt };
    }
    return {
      email,
      code: mapToCode(data),
      providerRawCode: String(data.resultcode ?? data.result ?? "unknown"),
      costUsd: ESTIMATED_COST_PER_EMAIL_USD,
      checkedAt,
    };
  } catch {
    return { email, code: "unknown", providerRawCode: "network_error", costUsd: 0, checkedAt };
  }
}

async function runWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Real MillionVerifier-backed `EmailVerificationProvider` (Prompt 7 §20).
 * The Single API (`GET /api/v3/?api=...&email=...`) is a real-time,
 * per-email endpoint — there is no real-time batch endpoint, so
 * `verifyBatch` fans out with bounded concurrency rather than one bulk
 * call. The Bulk API (file upload + async polling) exists for large
 * offline verification and is intentionally not used here since the
 * domain interface expects a single synchronous batch response.
 */
export class MillionVerifierEmailVerificationProvider implements EmailVerificationProvider {
  readonly providerName = "millionverifier";

  constructor(private readonly config: MillionVerifierProviderConfig) {}

  async verifyBatch(emails: readonly string[]): Promise<{ outcomes: EmailVerificationOutcome[]; usage: ProviderUsageStats }> {
    const start = Date.now();
    const outcomes = await runWithConcurrency(emails, CONCURRENCY, (email) => verifyOne(email, this.config));
    const errors = outcomes.filter((o) => o.costUsd === 0).length; // costUsd stays 0 only on HTTP/network/provider-error paths, never on a real verdict

    return {
      outcomes,
      usage: {
        calls: emails.length,
        items: outcomes.length,
        errors,
        totalLatencyMs: Date.now() - start,
        costUsd: outcomes.reduce((sum, o) => sum + o.costUsd, 0),
        quotaRemaining: null,
      },
    };
  }
}
