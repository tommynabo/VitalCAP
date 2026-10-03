import { describe, expect, it } from "vitest";
import { evaluateContactEligibility } from "./contact-eligibility";

describe("evaluateContactEligibility", () => {
  it("allows valid email only when no later blocking layer denies it", () => {
    expect(evaluateContactEligibility({ hasEmail: true, verificationStatus: "valid" }))
      .toEqual({ eligible: true, reason: "eligible" });
    expect(evaluateContactEligibility({ hasEmail: true, verificationStatus: "valid", isSuppressed: true }))
      .toEqual({ eligible: false, reason: "suppressed" });
    expect(evaluateContactEligibility({ hasEmail: true, verificationStatus: "valid", complianceAllowed: false }))
      .toEqual({ eligible: false, reason: "compliance_blocked" });
  });

  it.each([
    ["invalid", "invalid"],
    ["disposable", "invalid"],
    ["bounced", "invalid"],
    ["unknown", "unverified"],
    ["unverified", "unverified"],
    ["risky", "risky"],
    ["catch_all", "risky"],
  ] as const)("blocks %s by default", (verificationStatus, reason) => {
    expect(evaluateContactEligibility({ hasEmail: true, verificationStatus }))
      .toEqual({ eligible: false, reason });
  });

  it("allows catch-all only when explicitly configured", () => {
    expect(evaluateContactEligibility({ hasEmail: true, verificationStatus: "catch_all", allowCatchAll: true }))
      .toEqual({ eligible: true, reason: "eligible" });
  });

  it("reports no_email when no endpoint exists", () => {
    expect(evaluateContactEligibility({ hasEmail: false }))
      .toEqual({ eligible: false, reason: "no_email" });
  });
});