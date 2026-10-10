import { describe, expect, it } from "vitest";
import { evaluateSpainEligibility } from "@/lib/geography/spain-eligibility";
import { mergeMissingAccountFields, type IncomingAccountFields } from "./account-enrichment-merge";

const emptyIncoming: IncomingAccountFields = {
  phone: null,
  normalizedPhone: null,
  websiteUrl: null,
  normalizedDomain: null,
  googlePlaceId: null,
  mapsUrl: null,
  addressLine: null,
  normalizedAddress: null,
  city: null,
  province: null,
  postalCode: null,
  latitude: null,
  longitude: null,
  rating: null,
  reviewCount: null,
  countryCode: null,
};

describe("mergeMissingAccountFields", () => {
  it("fills missing fields without overwriting stronger existing evidence", () => {
    const updates = mergeMissingAccountFields(
      { ...emptyIncoming, phone: "+34944112233", websiteUrl: "https://old.example.es" },
      { ...emptyIncoming, phone: "+34940000000", normalizedPhone: "+34940000000", websiteUrl: "https://new.example.es", city: "Madrid" },
    );
    expect(updates).toEqual({ normalizedPhone: "+34940000000", city: "Madrid" });
  });

  it("retains all legitimate incoming values that are absent", () => {
    const updates = mergeMissingAccountFields({ ...emptyIncoming }, { ...emptyIncoming, websiteUrl: "https://farmacia.es", rating: 4.8 });
    expect(updates).toEqual({ websiteUrl: "https://farmacia.es", rating: 4.8 });
  });

  it("combines strong facts from separate sources on one canonical account without replacing existing evidence", () => {
    const mapsFacts = { ...emptyIncoming, countryCode: "ES", city: "Madrid" };
    const afterMaps = { ...emptyIncoming, ...mergeMissingAccountFields(emptyIncoming, mapsFacts) };
    const websiteFacts = { ...emptyIncoming, countryCode: null, postalCode: "28001" };
    const afterWebsite = { ...afterMaps, ...mergeMissingAccountFields(afterMaps, websiteFacts) };

    expect(afterWebsite).toMatchObject({ countryCode: "ES", city: "Madrid", postalCode: "28001" });
    expect(evaluateSpainEligibility({
      providerCountryCode: afterWebsite.countryCode,
      postalCode: afterWebsite.postalCode,
    }).verdict).toBe("verified");
  });
});
