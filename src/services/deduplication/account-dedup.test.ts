import { describe, expect, it } from "vitest";
import { businessIdentityDomain, classifyBusinessIdentityDomain, evaluateAccountDedup, type AccountIdentitySignals } from "./account-dedup";

const base: AccountIdentitySignals = {
  accountId: "acc_existing",
  normalizedName: "farmacia central",
  googlePlaceId: "place_123",
  normalizedDomain: "farmaciacentral.example.es",
  normalizedPhone: "+34944112233",
  postalCode: "48001",
  normalizedAddress: "calle mayor 1",
  latitude: 43.263,
  longitude: -2.935,
};

describe("evaluateAccountDedup — strong signals", () => {
  it("classifies known shared hosts without changing global URL normalization", () => {
    expect(classifyBusinessIdentityDomain("m.facebook.com")).toBe("socialPlatform");
    expect(classifyBusinessIdentityDomain("instagram.com")).toBe("socialPlatform");
    expect(classifyBusinessIdentityDomain("sites.google.com")).toBe("siteBuilder");
    expect(classifyBusinessIdentityDomain("my.wixsite.com")).toBe("siteBuilder");
    expect(classifyBusinessIdentityDomain("yelp.com")).toBe("directory");
    expect(classifyBusinessIdentityDomain("portal.farmaciascerca.es")).toBe("pharmacyDirectory");
    expect(classifyBusinessIdentityDomain("sensafarma.es")).toBe("sharedPharmacyPlatform");
    expect(classifyBusinessIdentityDomain("farmaciacentral.example.es")).toBe("first_party_candidate");
    expect(businessIdentityDomain("www.facebook.com/farmacia-punal")).toBeNull();
    expect(businessIdentityDomain("sensafarma.es")).toBeNull();
    expect(businessIdentityDomain("farmaciacentral.example.es")).toBe("farmaciacentral.example.es");
  });

  it("does not match unrelated businesses through verified pharmacy directories", () => {
    const directoryDomains = [
      "farmaciainfo7.com", "solofarmacias.es", "mapafarmacias.com", "sensafarma.es", "farmaciascerca.es",
      "guiadefarmacias.es", "topdoctors.es", "farmacias365.com", "tofarmacias.com", "farmacias.wiki",
      "farmaciasymedicamentos.com",
    ];

    for (const [index, normalizedDomain] of directoryDomains.entries()) {
      const existing = {
        ...base,
        googlePlaceId: `directory-place-${index}`,
        normalizedDomain,
        normalizedPhone: `+34944000${String(index).padStart(3, "0")}`,
      };
      const decision = evaluateAccountDedup({
        normalizedName: `unrelated pharmacy ${index}`,
        googlePlaceId: `unrelated-place-${index}`,
        normalizedDomain,
        normalizedPhone: `+34945000${String(index).padStart(3, "0")}`,
        normalizedAddress: `different street ${index}`,
        postalCode: `9${String(index).padStart(4, "0")}`,
      }, [existing]);

      expect(decision.action, normalizedDomain).toBe("no_match");
    }
  });

  it("merges on exact Google Place ID", () => {
    const decision = evaluateAccountDedup({ normalizedName: "otro nombre", googlePlaceId: "place_123" }, [base]);
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("google_place_id");
    expect(decision.confidence).toBe(1);
  });

  it("merges on exact normalized domain", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "otro nombre", normalizedDomain: "farmaciacentral.example.es" },
      [base],
    );
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("normalized_domain");
  });

  it("does not merge unrelated Facebook businesses with conflicting Place IDs", () => {
    const farmacia: AccountIdentitySignals = {
      accountId: "farmacia-punal",
      normalizedName: "farmacia punal",
      googlePlaceId: "ChIJCRxl9FJeZg0Ri7Hv5S_nbig",
      normalizedDomain: "facebook.com",
      normalizedPhone: "+34967000001",
      postalCode: "02001",
      normalizedAddress: "calle albacete 1",
    };
    const wellness = evaluateAccountDedup({
      normalizedName: "c2 relajacion recuperacion sanat",
      googlePlaceId: "ChIJ__8P-M_8RQ0RQu1oHu3l_d0",
      normalizedDomain: "facebook.com",
      normalizedPhone: "+34947000002",
      postalCode: "09001",
      normalizedAddress: "calle burgos 2",
    }, [farmacia]);

    expect(wellness.action).toBe("no_match");
  });

  it("does not merge different Instagram businesses or directory listings by host", () => {
    const pharmacy = { ...base, googlePlaceId: "pharmacy-place", normalizedDomain: "yelp.com" };
    const directoryMatch = evaluateAccountDedup({
      normalizedName: "farmacia distinta",
      googlePlaceId: "other-pharmacy-place",
      normalizedDomain: "yelp.com",
      normalizedAddress: "otra calle",
    }, [pharmacy]);
    const instagramMatch = evaluateAccountDedup({
      normalizedName: "estudio bienestar",
      googlePlaceId: "wellness-place",
      normalizedDomain: "instagram.com",
      normalizedAddress: "otra ciudad",
    }, [{ ...base, normalizedDomain: "instagram.com" }]);

    expect(directoryMatch.action).toBe("no_match");
    expect(instagramMatch.action).toBe("no_match");
  });

  it("flags a first-party domain match when Place IDs conflict", () => {
    const decision = evaluateAccountDedup({
      normalizedName: "farmacia central norte",
      googlePlaceId: "place-branch-b",
      normalizedDomain: "farmaciacentral.example.es",
    }, [base]);

    expect(decision).toMatchObject({ action: "flag_for_review", matches: [{ signal: "normalized_domain" }] });
  });

  it("flags separate physical branches that share a corporate domain", () => {
    const branchA: AccountIdentitySignals = {
      ...base,
      googlePlaceId: "branch-albacete",
      normalizedDomain: "farmacia-chain.example.es",
      normalizedPhone: "+34967000001",
      normalizedAddress: "calle albacete 1",
      postalCode: "02001",
      latitude: 38.9943,
      longitude: -1.8585,
    };
    const branchB = evaluateAccountDedup({
      normalizedName: "farmacia cadena",
      googlePlaceId: "branch-burgos",
      normalizedDomain: "www.farmacia-chain.example.es",
      normalizedPhone: "+34947000002",
      normalizedAddress: "calle burgos 2",
      postalCode: "09001",
      latitude: 42.3439,
      longitude: -3.6969,
    }, [branchA]);

    expect(branchB).toMatchObject({ action: "no_match", matches: [] });
  });

  it("keeps observed first-party chain domains eligible for location-aware identity matching", () => {
    const chainDomains = ["arenal.com", "druni.es", "herbolarionavarro.es", "laventananatural.com", "primor.eu"];

    for (const [index, normalizedDomain] of chainDomains.entries()) {
      expect(classifyBusinessIdentityDomain(normalizedDomain), normalizedDomain).toBe("first_party_candidate");
      const decision = evaluateAccountDedup({
        normalizedName: `chain location ${index} burgos`,
        googlePlaceId: `chain-place-b-${index}`,
        normalizedDomain,
        postalCode: "09001",
        normalizedAddress: "calle cadena 2",
        latitude: 42.3439,
        longitude: -3.6969,
      }, [{
        ...base,
        googlePlaceId: `chain-place-a-${index}`,
        normalizedDomain,
        normalizedPhone: null,
        postalCode: "02001",
        normalizedAddress: "calle cadena 1",
        latitude: 38.9943,
        longitude: -1.8585,
      }]);

      expect(decision.action, normalizedDomain).toBe("no_match");
    }
  });

  it("flags an exact phone match when Place IDs conflict", () => {
    const decision = evaluateAccountDedup({
      normalizedName: "farmacia central norte",
      googlePlaceId: "place-branch-b",
      normalizedPhone: base.normalizedPhone,
    }, [base]);

    expect(decision).toMatchObject({ action: "flag_for_review", matches: [{ signal: "normalized_phone" }] });
  });

  it("flags an exact name and address match when Place IDs conflict", () => {
    const decision = evaluateAccountDedup({
      normalizedName: base.normalizedName,
      googlePlaceId: "place-branch-b",
      normalizedAddress: base.normalizedAddress,
    }, [base]);

    expect(decision).toMatchObject({ action: "flag_for_review", matches: [{ signal: "name_address" }] });
  });

  it("merges on exact normalized phone", () => {
    const decision = evaluateAccountDedup({ normalizedName: "otro nombre", normalizedPhone: "+34944112233" }, [base]);
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("normalized_phone");
  });

  it("converges Maps Fast and Maps Deep candidates on the same Google Place ID", () => {
    const mapsDeepCandidate = { normalizedName: "farmacia central", googlePlaceId: "place_123" };
    const decision = evaluateAccountDedup(mapsDeepCandidate, [base]);
    expect(decision).toMatchObject({ action: "merge", matches: [{ accountId: "acc_existing", signal: "google_place_id" }] });
  });

  it("converges SERP and Maps candidates on the same normalized domain", () => {
    const serpCandidate = { normalizedName: "farmacia central online", normalizedDomain: "farmaciacentral.example.es" };
    const decision = evaluateAccountDedup(serpCandidate, [base]);
    expect(decision).toMatchObject({ action: "merge", matches: [{ accountId: "acc_existing", signal: "normalized_domain" }] });
  });

  it("uses Place ID before a phone that points at a different candidate", () => {
    const placeAccount: AccountIdentitySignals = {
      ...base,
      accountId: "acc_place_match",
      googlePlaceId: "place_other",
      normalizedPhone: "+34944112233",
    };
    const phoneAccount: AccountIdentitySignals = {
      ...base,
      accountId: "acc_phone_match",
      googlePlaceId: "place_other_2",
      normalizedPhone: "+34944000000",
    };
    const decision = evaluateAccountDedup(
      { normalizedName: "farmacia central", googlePlaceId: "place_other", normalizedPhone: "+34944000000" },
      [phoneAccount, placeAccount],
    );
    expect(decision).toMatchObject({ action: "merge", matches: [{ accountId: "acc_place_match", signal: "google_place_id" }] });
  });
});

describe("evaluateAccountDedup — fuzzy/composite signals and threshold behavior", () => {
  it("auto-merges name + address match (confidence above default threshold)", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "farmacia central", normalizedAddress: "calle mayor 1" },
      [base],
    );
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("name_address");
  });

  it("flags name + geo-proximity for review when confidence is below threshold", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "farmacia central", latitude: 43.2631, longitude: -2.9351 },
      [base],
      { fuzzyMergeThreshold: 0.9 },
    );
    expect(decision.action).toBe("flag_for_review");
    expect(decision.matches[0]?.signal).toBe("name_geo_proximity");
  });

  it("never merges on name alone without any corroborating signal", () => {
    const decision = evaluateAccountDedup({ normalizedName: "farmacia central" }, [base]);
    expect(decision.action).toBe("no_match");
  });

  it("does not merge the same name at another address and domain", () => {
    const decision = evaluateAccountDedup(
      {
        normalizedName: "farmacia central",
        normalizedDomain: "farmacia-central-sur.es",
        postalCode: "28080",
        normalizedAddress: "calle nueva 8",
      },
      [base],
    );
    expect(decision.action).toBe("no_match");
  });

  it("uses address before postal code and flags ambiguous composites for review", () => {
    const secondAtSamePostal: AccountIdentitySignals = {
      ...base,
      accountId: "acc_other_address",
      normalizedAddress: "calle nueva 2",
    };
    const decision = evaluateAccountDedup(
      { normalizedName: "farmacia central", postalCode: "48001", normalizedAddress: "calle mayor 1" },
      [base, secondAtSamePostal],
    );
    expect(decision).toMatchObject({ action: "merge", matches: [{ accountId: "acc_existing", signal: "name_address" }] });

    const ambiguous = evaluateAccountDedup(
      { normalizedName: "farmacia central", postalCode: "48001" },
      [base, secondAtSamePostal],
    );
    expect(ambiguous.action).toBe("flag_for_review");
  });

  it("never auto-merges on name and nearby coordinates alone", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "farmacia central", latitude: 43.2631, longitude: -2.9351 },
      [base],
    );
    expect(decision.action).toBe("flag_for_review");
  });

  it("does not match a genuinely different account", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "herbolario naturvida", normalizedDomain: "naturvida.example.es" },
      [base],
    );
    expect(decision.action).toBe("no_match");
    expect(decision.matches).toHaveLength(0);
  });
});
