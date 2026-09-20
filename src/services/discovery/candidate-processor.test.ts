import { describe, expect, it } from "vitest";
import type { EmailVerificationProvider, WebsiteFetcher } from "@/domain/providers/types";
import { createInMemoryVerificationCacheStore } from "@/services/verification/email-verification-cache";
import { processRawCandidate, type CandidateRawPayload } from "./candidate-processor";

function alwaysValidVerifier(): EmailVerificationProvider {
  return {
    providerName: "fake",
    verifyBatch: async (emails) => ({
      outcomes: emails.map((email) => ({ email, code: "valid" as const, providerRawCode: "OK", costUsd: 0.01, checkedAt: new Date().toISOString() })),
      usage: { calls: 1, items: emails.length, errors: 0, totalLatencyMs: 10, costUsd: 0.01 * emails.length, quotaRemaining: null },
    }),
  };
}

function fetcherReturning(body: string): WebsiteFetcher {
  return { fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", body }) };
}

function baseContext(overrides: Partial<Parameters<typeof processRawCandidate>[2]> = {}) {
  return {
    existingAccounts: [],
    websiteFetcher: fetcherReturning("<html>info@farmaciadelgado.es</html>"),
    verificationProvider: alwaysValidVerifier(),
    verificationCacheStore: createInMemoryVerificationCacheStore(),
    now: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("processRawCandidate — maps candidates", () => {
  it("rejects a candidate whose provider country code is not Spain", async () => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "p1",
        name: "Farmacia Lisboa",
        category: "farmacia",
        address: null,
        postalCode: null,
        province: null,
        city: null,
        countryCode: "PT",
        websiteUrl: null,
        phone: null,
        latitude: null,
        longitude: null,
        rating: null,
        reviewCount: null,
        sourceUrl: null,
      },
    };
    const result = await processRawCandidate(payload, "maps_fast", baseContext());
    expect(result.spainVerdict).toBe("rejected");
    expect(result.readyForOutreach).toBe(false);
  });

  it("produces a ready-for-outreach account for a verified Spain candidate with a valid email", async () => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "p2",
        name: "Farmacia Delgado",
        category: "farmacia",
        address: "Calle Mayor 1",
        postalCode: "28001",
        province: "Madrid",
        city: "Madrid",
        countryCode: "ES",
        websiteUrl: "https://farmaciadelgado.es",
        phone: null,
        latitude: null,
        longitude: null,
        rating: 4.5,
        reviewCount: 20,
        sourceUrl: "https://maps.example.com/place/p2",
      },
    };
    const result = await processRawCandidate(payload, "maps_fast", baseContext());
    expect(result.spainVerdict).toBe("verified");
    expect(result.businessType).toBe("pharmacy");
    expect(result.contactPoints.length).toBeGreaterThan(0);
    expect(result.readyForOutreach).toBe(true);
  });

  it("marks a global duplicate (matching google place id) and does not mark it ready", async () => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "existing_place",
        name: "Farmacia Delgado",
        category: "farmacia",
        address: null,
        postalCode: "28001",
        province: "Madrid",
        city: "Madrid",
        countryCode: "ES",
        websiteUrl: "https://farmaciadelgado.es",
        phone: null,
        latitude: null,
        longitude: null,
        rating: null,
        reviewCount: null,
        sourceUrl: null,
      },
    };
    const result = await processRawCandidate(
      payload,
      "maps_fast",
      baseContext({ existingAccounts: [{ accountId: "acc_1", normalizedName: "farmacia delgado", googlePlaceId: "existing_place" }] }),
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.readyForOutreach).toBe(false);
    expect(result.rejectionReason).toContain("Duplicate");
  });

  it("uses already-crawled pages for a maps_deep candidate instead of re-fetching", async () => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "p3",
        name: "Farmacia Deep",
        category: "farmacia",
        address: null,
        postalCode: "28001",
        province: "Madrid",
        city: "Madrid",
        countryCode: "ES",
        websiteUrl: "https://farmaciadeep.es",
        phone: null,
        latitude: null,
        longitude: null,
        rating: null,
        reviewCount: null,
        sourceUrl: null,
      },
      crawledPages: [{ url: "https://farmaciadeep.es/aviso-legal", body: "Titular: maria.garcia@farmaciadeep.es" }],
    };
    const fetcher: WebsiteFetcher = { fetchPage: async () => { throw new Error("should not be called"); } };
    const result = await processRawCandidate(payload, "maps_deep", baseContext({ websiteFetcher: fetcher }));
    expect(result.contactPoints.some((cp) => cp.email === "maria.garcia@farmaciadeep.es")).toBe(true);
  });
});

describe("processRawCandidate — serp candidates", () => {
  it("processes a google_serp result via domain resolution", async () => {
    const payload: CandidateRawPayload = {
      kind: "serp",
      result: { title: "Farmacia Ejemplo", url: "https://farmacia-ejemplo.es/", snippet: "Suplementos y vitaminas", domain: "farmacia-ejemplo.es" },
      geography: "Madrid",
    };
    const result = await processRawCandidate(payload, "google_serp", baseContext());
    expect(result.accountKey).toBe("domain:farmacia-ejemplo.es");
  });
});

describe("processRawCandidate — linkedin candidates", () => {
  it("never fabricates a contact when no resolved employer domain is available", async () => {
    const payload: CandidateRawPayload = {
      kind: "linkedin",
      profile: { title: "María García — Titular Farmacéutico", url: "https://www.linkedin.com/in/maria-garcia", snippet: "Titular en Farmacia García", domain: "linkedin.com" },
      resolvedEmployerDomain: null,
      geography: "Madrid",
    };
    const result = await processRawCandidate(payload, "linkedin_owner", baseContext());
    expect(result.contactPoints).toHaveLength(0);
    expect(result.readyForOutreach).toBe(false);
  });
});
