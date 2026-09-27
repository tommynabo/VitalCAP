import { describe, it, expect, vi } from "vitest";
import { WebsiteEnrichmentService } from "./website-enrichment-service";
import type { WebsiteFetcher } from "@/domain/providers/types";
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
});
