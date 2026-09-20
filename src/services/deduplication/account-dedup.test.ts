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

  it("does not match a genuinely different account", () => {
    const decision = evaluateAccountDedup(
      { normalizedName: "herbolario naturvida", normalizedDomain: "naturvida.example.es" },
      [base],
    );
    expect(decision.action).toBe("no_match");
    expect(decision.matches).toHaveLength(0);
  });
});
