import { describe, expect, it, vi } from "vitest";
import type { EmailVerificationProvider } from "@/domain/providers/types";
import { createInMemoryVerificationCacheStore, verifyEmailsWithCache } from "./email-verification-cache";

function makeProvider(): EmailVerificationProvider {
  return {
    providerName: "fake",
    verifyBatch: vi.fn(async (emails: readonly string[]) => ({
      outcomes: emails.map((email) => ({
        email,
        code: "valid" as const,
        providerRawCode: "OK",
        costUsd: 0.01,
        checkedAt: new Date().toISOString(),
      })),
      usage: { calls: 1, items: emails.length, errors: 0, totalLatencyMs: 50, costUsd: emails.length * 0.01, quotaRemaining: null },
    })),
  };
}

describe("verifyEmailsWithCache", () => {
  it("calls the provider for a fresh (uncached) email", async () => {
    const provider = makeProvider();
    const store = createInMemoryVerificationCacheStore();
    const result = await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, new Date("2025-01-01T00:00:00Z"));
    expect(provider.verifyBatch).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0]?.code).toBe("valid");
    expect(result.cacheHits).toBe(0);
  });

  it("serves a fresh cache entry without calling the provider again", async () => {
    const provider = makeProvider();
    const store = createInMemoryVerificationCacheStore();
    const now = new Date("2025-01-01T00:00:00Z");
    await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, now);
    const second = await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, new Date("2025-01-02T00:00:00Z"));
    expect(provider.verifyBatch).toHaveBeenCalledTimes(1);
    expect(second.cacheHits).toBe(1);
  });

  it("re-verifies once the cached entry has expired (TTL elapsed)", async () => {
    const provider = makeProvider();
    const store = createInMemoryVerificationCacheStore();
    const now = new Date("2025-01-01T00:00:00Z");
    await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, now, 1000);
    await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, new Date(now.getTime() + 5000), 1000);
    expect(provider.verifyBatch).toHaveBeenCalledTimes(2);
  });

  it("dedupes duplicate emails within a single call and batches the remainder in one provider call", async () => {
    const provider = makeProvider();
    const store = createInMemoryVerificationCacheStore();
    const result = await verifyEmailsWithCache(
      provider,
      ["a@x.es", "a@x.es", "b@x.es"],
      store,
      new Date("2025-01-01T00:00:00Z"),
    );
    expect(provider.verifyBatch).toHaveBeenCalledWith(["a@x.es", "b@x.es"]);
    expect(result.outcomes).toHaveLength(2);
  });

  it("tracks cost/result/provider-raw-code/checked_at/expires_at on every cached entry", async () => {
    const provider = makeProvider();
    const store = createInMemoryVerificationCacheStore();
    const result = await verifyEmailsWithCache(provider, ["info@farmaciadelgado.es"], store, new Date("2025-01-01T00:00:00Z"));
    const entry = result.outcomes[0]!;
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(entry.providerRawCode).toBe("OK");
    expect(entry.checkedAt).toBeTruthy();
    expect(entry.expiresAt).toBeTruthy();
  });
});
