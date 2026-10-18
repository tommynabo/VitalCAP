import { describe, expect, it } from "vitest";
import { calculateProductionPipelineRates, classifyProductionPrimaryLossStage } from "./production-pipeline-metrics";

describe("calculateProductionPipelineRates", () => {
  it("calculates account-level stage conversion rates", () => {
    expect(calculateProductionPipelineRates({
      rawCandidates: 100,
      processedRawCandidates: 90,
      accountsLinked: 80,
      websitePresent: 60,
      websiteAccountsWithEmail: 30,
      accountsWithEmail: 40,
      verificationValid: 30,
      eligible: 15,
      instantlyImported: 12,
    })).toEqual({
      rawToAccount: 0.8,
      accountToWebsite: 0.75,
      websiteToEmail: 0.5,
      rawToEmail: 40 / 90,
      emailToValid: 0.75,
      validToEligible: 0.5,
      eligibleToImport: 0.8,
    });
  });

  it("returns null when a cohort stage has no denominator", () => {
    expect(calculateProductionPipelineRates({
      rawCandidates: 0,
      processedRawCandidates: 0,
      accountsLinked: 0,
      websitePresent: 0,
      websiteAccountsWithEmail: 0,
      accountsWithEmail: 0,
      verificationValid: 0,
      eligible: 0,
      instantlyImported: 0,
    })).toEqual({
      rawToAccount: null,
      accountToWebsite: null,
      websiteToEmail: null,
      rawToEmail: null,
      emailToValid: null,
      validToEligible: null,
      eligibleToImport: null,
    });
  });
});

describe("classifyProductionPrimaryLossStage", () => {
  const base = {
    rawCandidates: 100,
    accountsLinked: 100,
    websiteMissing: 0,
    websiteFetchFailed: 0,
    websiteFetchSucceeded: 0,
    websiteAccountsWithEmail: 0,
    emailRejectedFormat: null,
    emailDuplicate: null,
    accountsWithEmail: 0,
    verificationValid: 0,
    icpRejected: 0,
    eligible: 0,
    instantlyImported: 0,
  };

  it("identifies the largest measured stage loss", () => {
    expect(classifyProductionPrimaryLossStage({ ...base, websiteMissing: 70 })).toBe("NO_WEBSITE");
    expect(classifyProductionPrimaryLossStage({ ...base, websiteFetchFailed: 70 })).toBe("WEBSITE_FETCH_FAILURE");
    expect(classifyProductionPrimaryLossStage({ ...base, icpRejected: 70 })).toBe("ICP_FILTER_LOSS");
    expect(classifyProductionPrimaryLossStage({
      ...base,
      websiteFetchSucceeded: 70,
      websiteAccountsWithEmail: 70,
      accountsWithEmail: 70,
    })).toBe("VERIFICATION_LOSS");
  });

  it("does not report a primary loss when all measured losses are zero", () => {
    expect(classifyProductionPrimaryLossStage(base)).toBe("OTHER");
  });
});