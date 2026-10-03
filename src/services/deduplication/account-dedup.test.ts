import { describe, expect, it } from "vitest";
import { evaluateAccountDedup, type AccountIdentitySignals } from "./account-dedup";

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
