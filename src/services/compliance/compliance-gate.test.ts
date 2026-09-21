import { describe, expect, it } from "vitest";
import type { SuppressionEntry } from "@/domain/outreach/types";
import { SuppressionAwareComplianceGate } from "./compliance-gate";

describe("SuppressionAwareComplianceGate", () => {
  it("blocks a send when the contact point is suppressed, regardless of eligibility status", async () => {
    const entries: SuppressionEntry[] = [
      { id: "s1", workspaceId: "ws_demo", contactPointId: "cp_1", accountId: null, reason: "unsubscribe", createdAt: "2025-01-01T00:00:00Z" },
    ];
    const gate = new SuppressionAwareComplianceGate(() => entries);
    const result = await gate.check({
      contactPointId: "cp_1",
      accountId: "acc_1",
      campaignId: "camp_1",
      channel: "email",
      currentEligibility: "eligible_email",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Suppressed");
  });

  it("allows an email send for an eligible, non-suppressed contact", async () => {
    const gate = new SuppressionAwareComplianceGate(() => []);
    const result = await gate.check({
      contactPointId: "cp_2",
      accountId: "acc_2",
      campaignId: "camp_1",
      channel: "email",
      currentEligibility: "professional_contact",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks an SMS send for a contact that is only email-eligible (channel eligibility is not transitive)", async () => {
    const gate = new SuppressionAwareComplianceGate(() => []);
    const result = await gate.check({
      contactPointId: "cp_3",
      accountId: "acc_3",
      campaignId: "camp_1",
      channel: "phone",
      currentEligibility: "eligible_email",
    });
    expect(result.allowed).toBe(false);
  });

  it("always blocks an opted_out contact regardless of channel", async () => {
    const gate = new SuppressionAwareComplianceGate(() => []);
    const result = await gate.check({
      contactPointId: "cp_4",
      accountId: "acc_4",
      campaignId: "camp_1",
      channel: "email",
      currentEligibility: "opted_out",
    });
    expect(result.allowed).toBe(false);
  });
});
