import { describe, it, expect, vi } from "vitest";
import { WebsiteEnrichmentService } from "./website-enrichment-service";
import { evaluateSpainEligibility } from "@/lib/geography/spain-eligibility";
import type { FetchedPage, WebsiteFetchOptions, WebsiteFetcher } from "@/domain/providers/types";
import { SafeFetchError } from "@/lib/security/safe-fetch";

describe("WebsiteEnrichmentService", () => {
  it("should process valid evidence without double generic assumption", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: async (url: string) => {
        if (url.includes("test.com")) {
          return {
            url: "https://test.com/",
            status: 200,
            contentType: "text/html",
            body: `
              <html>
                <a href="mailto:info@test.com">Contact</a>
                <a href="mailto:pedidos2024@test.com">Pedidos</a>
                <p>Teléfono: 600 123 456</p>
                <p>Otro: +34 600 987 654</p>
                <p>Nuestra farmacia ofrece suplementos.</p>
                <p>María García, farmacéutico titular, está aquí.</p>
                <p>El gerente te ayudará.</p>
              </html>
            `,
          };
        }
        throw new Error("Not found");
      },
    };

    const service = new WebsiteEnrichmentService(fetcher);
    const result = await service.enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://test.com",
    });

    expect(result.status).toBe("completed");
    expect(result.internalPagesFetched).toBe(0);
    expect(result.emailCandidatesFound).toBe(2);
    
    const emails = result.evidence.filter(e => e.evidenceType === "email");
    expect(emails).toHaveLength(2);
    const infoEmail = emails.find(e => e.value === "info@test.com");
    expect(infoEmail?.isGeneric).toBe(true);
    expect(infoEmail?.isPersonalOrNamed).toBe(false);

    const pedidosEmail = emails.find(e => e.value === "pedidos2024@test.com");
    expect(pedidosEmail?.isGeneric).toBe(false);
    expect(pedidosEmail?.isPersonalOrNamed).toBe(false);

    const phones = result.evidence.filter(e => e.evidenceType === "phone");
    expect(phones).toHaveLength(2);
    expect(phones.map(p => p.normalizedValue)).toContain("+34600123456");
    expect(phones.map(p => p.normalizedValue)).toContain("+34600987654");

    const signals = result.evidence.filter(e => e.evidenceType === "business_signal" || e.evidenceType === "supplement_signal");
    expect(signals.map(s => s.value)).toContain("farmacia");
    expect(signals.map(s => s.value)).toContain("suplementos");

    const roles = result.evidence.filter(e => e.evidenceType === "named_role" || e.evidenceType === "role_signal");
    const namedRole = roles.find(r => r.evidenceType === "named_role");
    expect(namedRole?.value).toBe("farmacéutico titular");
    expect(namedRole?.normalizedValue).toBe("María García");

    const roleSignal = roles.find(r => r.evidenceType === "role_signal");
    expect(roleSignal?.value).toBe("gerente");
    expect(roleSignal?.normalizedValue).toBe("gerente");
  });

  it("extracts a visible email from the prioritized contact page and keeps its source URL", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (url: string) => url.endsWith("/contacto")
        ? {
            url,
            status: 200,
            contentType: "text/html",
            body: '<div style="display:none">hidden@farmacia.es</div><script>tracker@thirdparty.es</script><p>Contacta con nosotros: info@farmacia.es</p>',
          }
        : {
            url: "https://farmacia.es/",
            status: 200,
            contentType: "text/html",
            body: '<a href="/contacto">Contacto</a><a href="https://thirdparty.es/contacto">External contact</a>',
          }),
    };
    const result = await new WebsiteEnrichmentService(fetcher).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://farmacia.es/",
    });
    const emails = result.evidence.filter((fact) => fact.evidenceType === "email");

    expect(result.status).toBe("completed");
    expect(result.pagesFetched).toBe(2);
    expect(result.internalPagesFetched).toBe(1);
    expect(result.emailCandidatesFound).toBe(1);
    expect(emails).toEqual([expect.objectContaining({
      value: "info@farmacia.es",
      sourceUrl: "https://farmacia.es/contacto",
    })]);
    expect(fetcher.fetchPage).not.toHaveBeenCalledWith("https://thirdparty.es/contacto");
  });

  it("extracts authoritative JSON-LD location facts from same-domain pages with provenance", async () => {
    const contactUrl = "https://farmacia.es/contacto";
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (url: string): Promise<FetchedPage> => url === contactUrl
        ? {
            url,
            status: 200,
            contentType: "text/html",
            body: `<script type="application/ld+json">${JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              address: {
                "@type": "PostalAddress",
                addressCountry: { "@type": "Country", name: "Spain" },
                postalCode: "28001",
              },
              geo: { "@type": "GeoCoordinates", latitude: 40.4168, longitude: -3.7038 },
            })}</script>`,
          }
        : {
            url: "https://farmacia.es/",
            status: 200,
            contentType: "text/html",
            body: '<a href="/contacto">Contacto</a><a href="https://thirdparty.es/contacto">External</a>',
          }),
    };

    const result = await new WebsiteEnrichmentService(fetcher).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://farmacia.es/",
    });
    const locations = result.evidence.filter((fact) => fact.evidenceType.startsWith("location_"));

    expect(locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceType: "location_country", value: "Spain", normalizedValue: "ES", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_postal_code", value: "28001", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_latitude", normalizedValue: "40.4168", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_longitude", normalizedValue: "-3.7038", sourceUrl: contactUrl }),
    ]));
    expect(fetcher.fetchPage).not.toHaveBeenCalledWith("https://thirdparty.es/contacto");
    expect(evaluateSpainEligibility({
      providerCountryCode: locations.find((fact) => fact.evidenceType === "location_country")?.normalizedValue,
      postalCode: locations.find((fact) => fact.evidenceType === "location_postal_code")?.normalizedValue,
      latitude: Number(locations.find((fact) => fact.evidenceType === "location_latitude")?.normalizedValue),
      longitude: Number(locations.find((fact) => fact.evidenceType === "location_longitude")?.normalizedValue),
    }).verdict).toBe("verified");
  });

  it("extracts Schema.org microdata location facts with page provenance", async () => {
    const contactUrl = "https://farmacia.es/contacto";
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (url: string): Promise<FetchedPage> => url === contactUrl
        ? {
            url,
            status: 200,
            contentType: "text/html",
            body: `<div itemscope itemtype="https://schema.org/Organization">
              <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
                <span itemprop="streetAddress">Calle Mayor 1</span>
                <span itemprop="postalCode">28001</span>
                <span itemprop="addressCountry" itemscope itemtype="https://schema.org/Country"><meta itemprop="name" content="España"></span>
              </div>
              <div itemprop="geo" itemscope itemtype="https://schema.org/GeoCoordinates">
                <meta itemprop="latitude" content="40.4168"><meta itemprop="longitude" content="-3.7038">
              </div>
            </div>`,
          }
        : {
            url: "https://farmacia.es/",
            status: 200,
            contentType: "text/html",
            body: '<a href="/contacto">Contacto</a>',
          }),
    };

    const result = await new WebsiteEnrichmentService(fetcher).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://farmacia.es/",
    });
    const locations = result.evidence.filter((fact) => fact.evidenceType.startsWith("location_"));

    expect(locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceType: "location_country", normalizedValue: "ES", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_postal_code", normalizedValue: "28001", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_latitude", normalizedValue: "40.4168", sourceUrl: contactUrl }),
      expect.objectContaining({ evidenceType: "location_longitude", normalizedValue: "-3.7038", sourceUrl: contactUrl }),
    ]));
    expect(evaluateSpainEligibility({
      providerCountryCode: locations.find((fact) => fact.evidenceType === "location_country")?.normalizedValue,
      postalCode: locations.find((fact) => fact.evidenceType === "location_postal_code")?.normalizedValue,
      latitude: Number(locations.find((fact) => fact.evidenceType === "location_latitude")?.normalizedValue),
      longitude: Number(locations.find((fact) => fact.evidenceType === "location_longitude")?.normalizedValue),
    }).verdict).toBe("verified");
  });

  it("extracts a Spanish postcode only when it shares a visible address block with a street and number", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: async () => ({
        url: "https://farmacia.es/contacto",
        status: 200,
        contentType: "text/html",
        body: `<address>Calle Mayor 1, 28001 Madrid</address>
          <p>Calle Mayor 1</p><p>28002 Madrid</p><p>Farmacia en Madrid</p>`,
      }),
    };

    const result = await new WebsiteEnrichmentService(fetcher).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://farmacia.es/contacto",
    });
    const postcodes = result.evidence.filter((fact) => fact.evidenceType === "location_postal_code");

    expect(postcodes).toEqual([expect.objectContaining({ value: "28001", sourceUrl: "https://farmacia.es/contacto" })]);
    expect(evaluateSpainEligibility({ websiteDomain: "farmacia.es", city: "Madrid" }).verdict).toBe("needs_review");
  });

  it("does not qualify weak JSON-LD or a non-Spain country", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: async () => ({
        url: "https://farmacia.es/",
        status: 200,
        contentType: "text/html",
        body: `<script type="application/ld+json">${JSON.stringify({
          "@type": "Organization",
          name: "Farmacia Madrid",
          url: "https://farmacia.es/",
          address: { "@type": "PostalAddress", addressLocality: "Madrid", addressCountry: "PT", postalCode: "99999" },
        })}</script>`,
      }),
    };

    const result = await new WebsiteEnrichmentService(fetcher).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://farmacia.es/",
    });
    const country = result.evidence.find((fact) => fact.evidenceType === "location_country");
    const postal = result.evidence.find((fact) => fact.evidenceType === "location_postal_code");

    expect(country?.normalizedValue).toBe("PT");
    expect(postal).toBeUndefined();
    expect(evaluateSpainEligibility({ providerCountryCode: country?.normalizedValue }).verdict).toBe("rejected");
    expect(evaluateSpainEligibility({ websiteDomain: "farmacia.es", city: "Madrid" }).verdict).toBe("needs_review");
  });

  it("should handle blocked unsafe urls as blocked_unsafe_url", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: async () => {
        throw new SafeFetchError("Private IP blocked", "blocked_ip");
      },
    };

    const service = new WebsiteEnrichmentService(fetcher);
    const result = await service.enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "http://127.0.0.1",
    });

    expect(result.status).toBe("blocked_unsafe_url");
  });

  it("should handle timeout correctly", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: async () => {
        throw new SafeFetchError("Request timed out", "timeout");
      },
    };

    const service = new WebsiteEnrichmentService(fetcher);
    const result = await service.enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://slow.com",
    });

    expect(result.status).toBe("timeout");
  });

  it("rejects the whole crawl deadline instead of returning partial no-email success", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (_url: string, options?: WebsiteFetchOptions): Promise<FetchedPage> => new Promise<FetchedPage>((_resolve, reject) => {
        const rejectOnAbort = () => reject(options?.signal?.reason);
        options?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
        if (options?.signal?.aborted) rejectOnAbort();
      })),
    };

    await expect(new WebsiteEnrichmentService(fetcher, 10).enrich({
      workspaceId: "ws_1",
      accountId: "acc_1",
      websiteUrl: "https://slow.example.es",
    })).rejects.toMatchObject({ name: "DeadlineExceededError", code: "WEBSITE_ENRICHMENT_TIMEOUT" });
  });
});
