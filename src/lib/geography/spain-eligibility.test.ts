import { describe, expect, it } from "vitest";
import { evaluateSpainEligibility } from "./spain-eligibility";

describe("evaluateSpainEligibility", () => {
  it("verifies on provider country code alone", () => {
    const result = evaluateSpainEligibility({ providerCountryCode: "ES" });
    expect(result.verdict).toBe("verified");
    expect(result.matchedSignals).toContain("provider_country_code_es");
  });

  it("verifies on a valid Spanish postal code alone", () => {
    const result = evaluateSpainEligibility({ postalCode: "41001" });
    expect(result.verdict).toBe("verified");
    expect(result.matchedSignals).toContain("valid_es_postal_code");
  });

  it("verifies on in-bounds coordinates alone", () => {
    const result = evaluateSpainEligibility({ latitude: 40.4168, longitude: -3.7038 });
    expect(result.verdict).toBe("verified");
    expect(result.matchedSignals).toContain("within_spain_bounding_box");
  });

  it("rejects an explicit non-Spain country code even with other hints", () => {
    const result = evaluateSpainEligibility({ providerCountryCode: "PT", phone: "+351 912345678" });
    expect(result.verdict).toBe("rejected");
  });

  it("stays needs_review on supporting-only evidence (phone/domain)", () => {
    const result = evaluateSpainEligibility({ phone: "+34612345678", websiteDomain: "example.es" });
    expect(result.verdict).toBe("needs_review");
    expect(result.matchedSignals).toEqual(expect.arrayContaining(["phone_plus34", "es_domain"]));
  });

  it("stays needs_review with no evidence at all, never silently verified", () => {
    const result = evaluateSpainEligibility({});
    expect(result.verdict).toBe("needs_review");
  });
});
