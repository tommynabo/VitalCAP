import { describe, expect, it } from "vitest";
import {
  calculateProductionPipelineRates,
  calculateRecoveryAttributionRates,
  classifyProductionPrimaryLossStage,
  classifyRecoveryPrimaryLossStage,
} from "./production-pipeline-metrics";

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

describe("recovered website attribution", () => {
  const ratesInput = {
    recoveryTelemetryCoveragePct: 100,
    recoveredFetchAttributionCoveragePct: 100,
    recoveredEmailAttributionCoveragePct: 100,
    recoveryAttempted: 10,
    recoverySucceeded: 8,
    recoveredFetchAttempted: 8,
    recoveredFetchSucceeded: 6,
    recoveredEmailFound: 3,
    recoveredValidEmail: 2,
    recoveredEligible: 1,
    recoveredImported: 1,
  };

  it("calculates each recovered-site transition from its own denominator", () => {
    expect(calculateRecoveryAttributionRates(ratesInput)).toEqual({
      recoverySuccessRate: 0.8,
      recoveredFetchSuccessRate: 0.75,
      recoveredFetchToEmailRate: 0.5,
      recoveredFetchToValidRate: 2 / 6,
      recoveredValidToEligibleRate: 0.5,
      recoveredEligibleToImportRate: 1,
    });
  });

  it("returns null rates when any attribution coverage is below 95 percent", () => {
    const nullRates = {
      recoverySuccessRate: null,
      recoveredFetchSuccessRate: null,
      recoveredFetchToEmailRate: null,
      recoveredFetchToValidRate: null,
      recoveredValidToEligibleRate: null,
      recoveredEligibleToImportRate: null,
    };
    for (const field of [
      "recoveryTelemetryCoveragePct",
      "recoveredFetchAttributionCoveragePct",
      "recoveredEmailAttributionCoveragePct",
    ] as const) {
      expect(calculateRecoveryAttributionRates({ ...ratesInput, [field]: 94.99 })).toEqual(nullRates);
    }
  });

  it("allows rates at exactly 95 percent coverage", () => {
    expect(calculateRecoveryAttributionRates({
      ...ratesInput,
      recoveryTelemetryCoveragePct: 95,
      recoveredFetchAttributionCoveragePct: 95,
      recoveredEmailAttributionCoveragePct: 95,
    }).recoverySuccessRate).toBe(0.8);
  });

  it("keeps zero-denominator rates null", () => {
    expect(calculateRecoveryAttributionRates({
      ...ratesInput,
      recoveryAttempted: 0,
      recoveredFetchAttempted: 0,
      recoveredFetchSucceeded: 0,
      recoveredEmailFound: 0,
      recoveredValidEmail: 0,
      recoveredEligible: 0,
      recoveredImported: 0,
    })).toMatchObject({
      recoverySuccessRate: null,
      recoveredFetchSuccessRate: null,
      recoveredFetchToEmailRate: null,
      recoveredFetchToValidRate: null,
      recoveredValidToEligibleRate: null,
      recoveredEligibleToImportRate: null,
    });
  });

  it("classifies measured recovery losses and refuses incomplete telemetry", () => {
    const base = {
      totalRows: 100,
      recoveryTelemetryCoveragePct: 100,
      recoveredFetchAttributionCoveragePct: 100,
      recoveredEmailAttributionCoveragePct: 100,
      noWebsiteOriginal: 0,
      recoveryNotAttempted: 0,
      recoveryFailed: 0,
      recoveredFetchFailed: 0,
      recoveredFetchSucceededNoEmail: 0,
      recoveredEmailInvalid: 0,
      recoveredValidNotEligible: 0,
      recoveredEligibleNotImported: 0,
    };
    expect(classifyRecoveryPrimaryLossStage({ ...base, recoveredFetchFailed: 12 })).toBe("RECOVERED_FETCH_FAILED");
    expect(classifyRecoveryPrimaryLossStage({ ...base, recoveredEmailInvalid: 12 })).toBe("RECOVERED_EMAIL_INVALID");
    expect(classifyRecoveryPrimaryLossStage({ ...base, recoveryTelemetryCoveragePct: 94 })).toBe("UNCLASSIFIED_DUE_TO_MISSING_TELEMETRY");
    expect(classifyRecoveryPrimaryLossStage({ ...base, recoveredEmailAttributionCoveragePct: 94 })).toBe("UNCLASSIFIED_DUE_TO_MISSING_TELEMETRY");
    expect(classifyRecoveryPrimaryLossStage({ ...base, recoveredFetchAttributionCoveragePct: null })).toBe("UNCLASSIFIED_DUE_TO_MISSING_TELEMETRY");
  });

  it("distinguishes each measured recovery loss stage", () => {
    const base = {
      totalRows: 100,
      recoveryTelemetryCoveragePct: 100,
      recoveredFetchAttributionCoveragePct: 100,
      recoveredEmailAttributionCoveragePct: 100,
      noWebsiteOriginal: 0,
      recoveryNotAttempted: 0,
      recoveryFailed: 0,
      recoveredFetchFailed: 0,
      recoveredFetchSucceededNoEmail: 0,
      recoveredEmailInvalid: 0,
      recoveredValidNotEligible: 0,
      recoveredEligibleNotImported: 0,
    };
    const cases = [
      [{ noWebsiteOriginal: 1 }, "NO_WEBSITE_ORIGINAL"],
      [{ recoveryNotAttempted: 1 }, "RECOVERY_NOT_ATTEMPTED"],
      [{ recoveryFailed: 1 }, "RECOVERY_FAILED"],
      [{ recoveredFetchFailed: 1 }, "RECOVERED_FETCH_FAILED"],
      [{ recoveredFetchSucceededNoEmail: 1 }, "RECOVERED_FETCH_SUCCEEDED_NO_EMAIL"],
      [{ recoveredEmailInvalid: 1 }, "RECOVERED_EMAIL_INVALID"],
      [{ recoveredValidNotEligible: 1 }, "RECOVERED_VALID_NOT_ELIGIBLE"],
      [{ recoveredEligibleNotImported: 1 }, "RECOVERED_ELIGIBLE_NOT_IMPORTED"],
    ] as const;

    for (const [counts, expected] of cases) {
      expect(classifyRecoveryPrimaryLossStage({ ...base, ...counts })).toBe(expected);
    }
  });
});