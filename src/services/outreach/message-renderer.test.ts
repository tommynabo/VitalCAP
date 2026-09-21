import { describe, expect, it } from "vitest";
import type { Offer } from "@/domain/campaigns/types";
import { renderMessageTemplate } from "./message-renderer";

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer_1",
    workspaceId: "ws_demo",
    name: "Demo Offer",
    company: "VitalCap",
    description: "Suplementos para farmacias",
    primaryCta: "Reserva una llamada",
    bookingUrl: "https://cal.com/vitalcap/demo",
    approvedCommercialFacts: {},
    approvedProductFacts: {},
    approvedClaims: [],
    forbiddenClaims: [],
    faq: [],
    objectionGuidance: {},
    toneConfig: {},
    active: true,
    ...overrides,
  };
}

describe("renderMessageTemplate", () => {
  it("substitutes known placeholders from the offer and contact context", () => {
    const rendered = renderMessageTemplate("Hola {{contact_first_name}}, soy de {{offer_company}}. {{offer_primary_cta}}: {{offer_booking_url}}", {
      contactFirstName: "Ana",
      accountName: "Farmacia Central",
      offer: offer(),
    });
    expect(rendered.body).toBe("Hola Ana, soy de VitalCap. Reserva una llamada: https://cal.com/vitalcap/demo");
    expect(rendered.missingPlaceholders).toHaveLength(0);
  });

  it("falls back to an empty string when a known value is null (no fabrication)", () => {
    const rendered = renderMessageTemplate("Hola {{contact_first_name}}!", { contactFirstName: null, accountName: "X", offer: offer() });
    expect(rendered.body).toBe("Hola !");
  });

  it("leaves unknown placeholders untouched and reports them as missing", () => {
    const rendered = renderMessageTemplate("Precio especial: {{unapproved_discount}}", {
      contactFirstName: "Ana",
      accountName: "X",
      offer: offer(),
    });
    expect(rendered.body).toBe("Precio especial: {{unapproved_discount}}");
    expect(rendered.missingPlaceholders).toEqual(["unapproved_discount"]);
  });
});
