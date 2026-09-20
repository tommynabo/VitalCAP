import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFICATION_ACCEPTANCE_POLICY, isContactPointAcceptable } from "./acceptance-policy";

describe("isContactPointAcceptable", () => {
  it("accepts valid and catch_all under the default policy", () => {
    expect(isContactPointAcceptable("valid")).toBe(true);
    expect(isContactPointAcceptable("catch_all")).toBe(true);
  });

  it("rejects risky/invalid/disposable/bounced under the default policy", () => {
    expect(isContactPointAcceptable("risky")).toBe(false);
    expect(isContactPointAcceptable("invalid")).toBe(false);
    expect(isContactPointAcceptable("disposable")).toBe(false);
    expect(isContactPointAcceptable("bounced")).toBe(false);
  });

  it("respects a campaign-configured wider policy", () => {
    const policy = { acceptedStatuses: [...DEFAULT_VERIFICATION_ACCEPTANCE_POLICY.acceptedStatuses, "unverified"] as const };
    expect(isContactPointAcceptable("unverified", policy)).toBe(true);
  });
});
