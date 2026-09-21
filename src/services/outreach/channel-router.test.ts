import { describe, expect, it } from "vitest";
import type { ContactPoint } from "@/domain/contacts/types";
import type { OutreachQueueItem, SuppressionEntry } from "@/domain/outreach/types";
import { routeAccountToEndpoint } from "./channel-router";

function contactPoint(overrides: Partial<ContactPoint> = {}): ContactPoint {
  return {
    id: "cp_1",
    workspaceId: "ws_demo",
    accountId: "acc_1",
    contactId: null,
    type: "email",
    value: "info@example.es",
    normalizedValue: "info@example.es",
    label: "info",
    isGeneric: true,
    isPersonalOrNamed: false,
    priorityScore: 60,
    verificationStatus: "valid",
    verificationProvider: null,
    verificationCheckedAt: null,
    channelEligibility: "eligible_email",
    sourceUrl: null,
    sourceType: null,
    lastContactedAt: null,
    status: "eligible",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

const now = new Date("2025-06-01T12:00:00Z");

describe("routeAccountToEndpoint", () => {
  it("selects the highest-priority eligible contact point (owner over info@)", () => {
    const owner = contactPoint({ id: "cp_owner", priorityScore: 100, isPersonalOrNamed: true, isGeneric: false, label: "owner" });
    const info = contactPoint({ id: "cp_info" });
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [info, owner],
      existingQueueItems: [],
      suppressionEntries: [],
      now,
    });
    expect(decision.selectedContactPointId).toBe("cp_owner");
    expect(decision.channel).toBe("email");
  });

  it("blocks with concurrent_active_path when the account already has an active outreach path", () => {
    const existing: OutreachQueueItem[] = [
      { id: "q1", campaignId: "camp_1", accountId: "acc_1", contactId: null, contactPointId: "cp_other", channel: "email", priority: 90, scheduledFor: null, state: "sent", deliveryMode: "dry_run" },
    ];
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [contactPoint()],
      existingQueueItems: existing,
      suppressionEntries: [],
      now,
    });
    expect(decision.blockedReason).toBe("concurrent_active_path");
    expect(decision.selectedContactPointId).toBeNull();
  });

  it("allows a second endpoint when allowMultiEndpointPerAccount is explicitly enabled", () => {
    const existing: OutreachQueueItem[] = [
      { id: "q1", campaignId: "camp_1", accountId: "acc_1", contactId: null, contactPointId: "cp_other", channel: "email", priority: 90, scheduledFor: null, state: "sent", deliveryMode: "dry_run" },
    ];
    const decision = routeAccountToEndpoint(
      { accountId: "acc_1", contactPoints: [contactPoint()], existingQueueItems: existing, suppressionEntries: [], now },
      { allowMultiEndpointPerAccount: true },
    );
    expect(decision.blockedReason).toBeNull();
    expect(decision.selectedContactPointId).toBe("cp_1");
  });

  it("blocks with account_cooldown when any contact point was contacted within the cooldown window", () => {
    const recentlyContacted = contactPoint({ lastContactedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() });
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [recentlyContacted],
      existingQueueItems: [],
      suppressionEntries: [],
      now,
    });
    expect(decision.blockedReason).toBe("account_cooldown");
  });

  it("blocks with suppressed when the account has an account-level suppression entry", () => {
    const suppression: SuppressionEntry[] = [
      { id: "s1", workspaceId: "ws_demo", contactPointId: null, accountId: "acc_1", reason: "account_do_not_contact", createdAt: now.toISOString() },
    ];
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [contactPoint()],
      existingQueueItems: [],
      suppressionEntries: suppression,
      now,
    });
    expect(decision.blockedReason).toBe("suppressed");
  });

  it("blocks with no_eligible_endpoint when every contact point is ineligible or unverified", () => {
    const risky = contactPoint({ verificationStatus: "risky" });
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [risky],
      existingQueueItems: [],
      suppressionEntries: [],
      now,
    });
    expect(decision.blockedReason).toBe("no_eligible_endpoint");
  });

  it("never selects an opted_out contact point even if it has the highest priority score", () => {
    const optedOutOwner = contactPoint({ id: "cp_owner", priorityScore: 100, channelEligibility: "opted_out" });
    const info = contactPoint({ id: "cp_info" });
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [optedOutOwner, info],
      existingQueueItems: [],
      suppressionEntries: [],
      now,
    });
    expect(decision.selectedContactPointId).toBe("cp_info");
  });

  it("falls back to phone when no email endpoint is eligible but an SMS-eligible phone exists", () => {
    const phone = contactPoint({ id: "cp_phone", type: "phone", value: "+34611222333", normalizedValue: "+34611222333", channelEligibility: "eligible_sms" });
    const decision = routeAccountToEndpoint({
      accountId: "acc_1",
      contactPoints: [phone],
      existingQueueItems: [],
      suppressionEntries: [],
      now,
    });
    expect(decision.selectedContactPointId).toBe("cp_phone");
    expect(decision.channel).toBe("phone");
  });
});
