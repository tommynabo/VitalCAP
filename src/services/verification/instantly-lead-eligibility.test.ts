import { describe, expect, it } from "vitest";
import { evaluateInstantlyLeadEligibility, type InstantlyEligibilityInput } from "./instantly-lead-eligibility";

const eligibleLead: InstantlyEligibilityInput = {
  hasEmail: true,
  verificationStatus: "valid",
  contactEligibility: "eligible",
  complianceAllowed: true,
  isSuppressed: false,
  hasPriorColdOutreach: false,
  isInFlight: false,
  alreadyInCampaign: false,
};

describe("evaluateInstantlyLeadEligibility", () => {
  it("allows only a valid, eligible, compliance-approved lead", () => {
    expect(evaluateInstantlyLeadEligibility(eligibleLead)).toEqual({ eligible: true, reason: "eligible" });
  });

  it.each(["invalid", "catch_all", "risky", "unknown", "disposable"] as const)(
    "blocks %s verification results",
    (verificationStatus) => {
      expect(evaluateInstantlyLeadEligibility({ ...eligibleLead, verificationStatus }).eligible).toBe(false);
    },
  );

  it.each([
    [{ isSuppressed: true }, "suppressed"],
    [{ contactEligibility: "unknown" }, "contact_not_eligible"],
    [{ complianceAllowed: false }, "compliance_blocked"],
    [{ hasPriorColdOutreach: true }, "prior_cold_outreach"],
    [{ isInFlight: true }, "already_in_flight"],
    [{ alreadyInCampaign: true }, "already_in_campaign"],
    [{ hasEmail: false }, "no_email"],
  ] as const)("blocks a lead when %o", (changes, reason) => {
    expect(evaluateInstantlyLeadEligibility({ ...eligibleLead, ...changes })).toEqual({ eligible: false, reason });
  });
});