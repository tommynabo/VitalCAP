import { describe, expect, it } from "vitest";
import type { SetterDraft } from "@/domain/conversations/types";
import { AUTO_SEND_ENABLED, canAutoSend, type AutonomyPolicyConfig } from "./autonomy-policy";

function draft(overrides: Partial<SetterDraft> = {}): SetterDraft {
  return {
    id: "draft-1",
    conversationMessageId: "msg-1",
    language: "es",
    branch: "PRICE",
    intentSummary: "summary",
    confidence: 0.95,
    draft: "draft text",
    needsHuman: false,
    reasonForHuman: null,
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "book_meeting",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function policy(overrides: Partial<AutonomyPolicyConfig> = {}): AutonomyPolicyConfig {
  return {
    campaignAutoSendEnabled: true,
    branchAllowlist: ["PRICE", "SEND_INFO"],
    minimumConfidence: 0.9,
    allowedContactTypes: ["email"],
    ...overrides,
  };
}

describe("AUTO_SEND_ENABLED", () => {
  it("is hardcoded to false", () => {
    expect(AUTO_SEND_ENABLED).toBe(false);
  });
});

describe("canAutoSend", () => {
  it("allows autosend when every condition is satisfied", () => {
    const result = canAutoSend({ draft: draft(), contactType: "email", policy: policy() });
    expect(result.canAutoSend).toBe(true);
    expect(result.blockedReasons).toEqual([]);
  });

  it("blocks when the campaign does not permit autosend", () => {
    const result = canAutoSend({ draft: draft(), contactType: "email", policy: policy({ campaignAutoSendEnabled: false }) });
    expect(result.canAutoSend).toBe(false);
    expect(result.blockedReasons).toContain("campaign_does_not_permit_autosend");
  });

  it("blocks when the branch is not in the allowlist", () => {
    const result = canAutoSend({ draft: draft({ branch: "MARGIN" }), contactType: "email", policy: policy() });
    expect(result.blockedReasons).toContain("branch_not_in_allowlist");
  });

  it("blocks when confidence is below the minimum threshold", () => {
    const result = canAutoSend({ draft: draft({ confidence: 0.5 }), contactType: "email", policy: policy() });
    expect(result.blockedReasons).toContain("confidence_below_threshold");
  });

  it("blocks when risk flags are present", () => {
    const result = canAutoSend({ draft: draft({ riskFlags: ["pricing_claim"] }), contactType: "email", policy: policy() });
    expect(result.blockedReasons).toContain("risk_flags_present");
  });

  it("blocks when the draft is marked needsHuman", () => {
    const result = canAutoSend({ draft: draft({ needsHuman: true }), contactType: "email", policy: policy() });
    expect(result.blockedReasons).toContain("draft_marked_needs_human");
  });

  it("blocks when the contact type is not permitted", () => {
    const result = canAutoSend({ draft: draft(), contactType: "phone", policy: policy() });
    expect(result.blockedReasons).toContain("contact_type_not_permitted");
  });

  it("accumulates multiple blocked reasons at once", () => {
    const result = canAutoSend({
      draft: draft({ branch: "MARGIN", confidence: 0.1, riskFlags: ["x"], needsHuman: true }),
      contactType: "phone",
      policy: policy({ campaignAutoSendEnabled: false }),
    });
    expect(result.blockedReasons.length).toBeGreaterThanOrEqual(5);
  });
});
