import { describe, expect, it } from "vitest";
import {
  classifyEmailChannelEligibility,
  deriveEmailChannelEligibility,
  evaluateB2BEmailCompliance,
  isEmailChannelEligible,
  VITALCAP_B2B_EMAIL_POLICY_VERSION,
} from "./email-channel-policy";

describe("email channel policy", () => {
  it.each([
    ["eligible_email", true],
    ["consented_email", true],
    ["prior_relationship", true],
    ["professional_contact", true],
    ["unknown", false],
    ["opted_out", false],
    ["blocked", false],
  ] as const)("classifies %s consistently", (status, eligible) => {
    expect(isEmailChannelEligible(status)).toBe(eligible);
    expect(classifyEmailChannelEligibility(status).eligible).toBe(eligible);
  });

  it("requires review for unknown eligibility without treating it as consent", () => {
    expect(classifyEmailChannelEligibility("unknown")).toMatchObject({
      eligible: false,
      requiresReview: true,
      blocked: false,
      normalizedStatus: "unknown",
      reasonCode: "email_channel_review_required",
    });
  });

  it("derives unknown when discovery has no explicit eligibility evidence", () => {
    expect(deriveEmailChannelEligibility()).toBe("unknown");
    expect(deriveEmailChannelEligibility({ existingStatus: "unknown" })).toBe("unknown");
  });

  it("derives explicit statuses only from matching evidence and preserves opt-outs", () => {
    expect(deriveEmailChannelEligibility({ explicitConsent: true })).toBe("consented_email");
    expect(deriveEmailChannelEligibility({ priorRelationship: true })).toBe("prior_relationship");
    expect(deriveEmailChannelEligibility({ verifiedProfessionalContact: true })).toBe("professional_contact");
    expect(deriveEmailChannelEligibility({ explicitConsent: true, explicitOptOut: true })).toBe("opted_out");
  });

  it("blocks opt-outs and explicit blocks", () => {
    expect(classifyEmailChannelEligibility("opted_out")).toMatchObject({ blocked: true, eligible: false });
    expect(classifyEmailChannelEligibility("blocked")).toMatchObject({ blocked: true, eligible: false });
  });

  it("requires explicit policy approval before allowing a verified professional contact", () => {
    expect(evaluateB2BEmailCompliance({
      channelEligibility: "professional_contact",
      verificationStatus: "valid",
      isSuppressed: false,
      allowCatchAll: false,
      policyApproved: false,
    })).toMatchObject({ decision: "review_required", reasonCode: "b2b_email_policy_not_approved" });
    expect(VITALCAP_B2B_EMAIL_POLICY_VERSION).toBe("v2.0.0");
  });

  it("allows a verified contact only after policy approval and blocks suppression", () => {
    const input = {
      channelEligibility: "eligible_email" as const,
      verificationStatus: "valid" as const,
      isSuppressed: false,
      allowCatchAll: false,
      policyApproved: true,
    };
    expect(evaluateB2BEmailCompliance(input).decision).toBe("allowed");
    expect(evaluateB2BEmailCompliance({ ...input, isSuppressed: true }).decision).toBe("blocked");
  });

  it("keeps invalid blocked and risky or unapproved catch-all under review", () => {
    const base = {
      channelEligibility: "eligible_email" as const,
      isSuppressed: false,
      allowCatchAll: false,
      policyApproved: true,
    };
    expect(evaluateB2BEmailCompliance({ ...base, verificationStatus: "invalid" }).decision).toBe("blocked");
    expect(evaluateB2BEmailCompliance({ ...base, verificationStatus: "risky" }).decision).toBe("review_required");
    expect(evaluateB2BEmailCompliance({ ...base, verificationStatus: "catch_all" }).decision).toBe("review_required");
  });
});