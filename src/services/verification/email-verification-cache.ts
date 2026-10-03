import type { EmailVerificationOutcome, EmailVerificationProvider, ProviderUsageStats } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";

/**
 * TTL cache in front of an `EmailVerificationProvider` (Prompt 2 §2.7).
 * Never re-pays to revalidate an email whose cached result hasn't expired.
 * The cache is the business-logic layer (`services/`); the provider it
 * wraps is an infrastructure adapter injected by the caller — this module
 * never imports a concrete provider.
 */

export interface CachedVerification extends EmailVerificationOutcome {
  expiresAt: string;
}

export interface EmailVerificationCacheStore {
  get(email: string): Promise<CachedVerification | undefined>;
  set(email: string, value: CachedVerification): Promise<void>;
}

export function createInMemoryVerificationCacheStore(): EmailVerificationCacheStore {
  const map = new Map<string, CachedVerification>();
  return {
    get: async (email) => map.get(email),
    set: async (email, value) => void map.set(email, value),
  };
}

export interface VerifyWithCacheResult {
  outcomes: CachedVerification[];
  usage: ProviderUsageStats;
  /** How many of the requested emails were served from cache without a provider call. */
  cacheHits: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Verifies a batch of emails, serving fresh cache entries directly and only
 * calling the provider (in one batch call) for the remainder.
 */
export async function verifyEmailsWithCache(
  provider: EmailVerificationProvider,
  emails: readonly string[],
  store: EmailVerificationCacheStore,
  now: Date,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<VerifyWithCacheResult> {
  const unique = Array.from(new Set(emails));
  const fresh: CachedVerification[] = [];
  const toVerify: string[] = [];

  for (const email of unique) {
    const cached = await store.get(email);
    if (cached && new Date(cached.expiresAt).getTime() > now.getTime()) {
      fresh.push(cached);
    } else {
      toVerify.push(email);
    }
  }

  if (toVerify.length === 0) {
    return { outcomes: fresh, usage: emptyProviderUsageStats(), cacheHits: fresh.length };
  }

  const { outcomes, usage } = await provider.verifyBatch(toVerify);
  const newlyCached: CachedVerification[] = outcomes.filter((outcome) => !outcome.retryable).map((outcome) => ({
    ...outcome,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  }));
  for (const entry of newlyCached) {
    await store.set(entry.email, entry);
  }

  const retryableOutcomes: CachedVerification[] = outcomes
    .filter((outcome) => outcome.retryable)
    .map((outcome) => ({ ...outcome, expiresAt: now.toISOString() }));
  return { outcomes: [...fresh, ...retryableOutcomes, ...newlyCached], usage, cacheHits: fresh.length };
}
