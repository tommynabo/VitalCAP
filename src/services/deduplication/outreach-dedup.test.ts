import { describe, expect, it } from "vitest";
import {
  canEnterColdOutreach,
  evaluateOutreachAttempt,
  hasActualPriorColdOutreach,
  isDryRunOnlyOutreach,
  type RecentOutreachEvent,
} from "./outreach-dedup";

const baseContext = {
  contactPointId: "cp_owner",
  accountId: "acc_1",
  campaignId: "campaign_maps_fast",
  channel: "email" as const,
  now: "2026-01-15T09:00:00.000Z",
};

describe("actual prior cold outreach", () => {
  it("does not treat a scheduled dry-run row as actual outreach", () => {
    const history = { deliveryMode: "dry_run" as const, queueState: "scheduled" as const, eventStates: [] };

    expect(isDryRunOnlyOutreach(history)).toBe(true);
    expect(hasActualPriorColdOutreach(history)).toBe(false);
  });

  it("does not treat a sent dry-run queue state alone as actual outreach", () => {
    expect(hasActualPriorColdOutreach({
      deliveryMode: "dry_run",
      queueState: "sent",
      eventStates: [],
    })).toBe(false);
  });

  it.each(["provider_submitted", "sent", "delivered", "replied"] as const)("counts %s provider evidence", (state) => {
    expect(hasActualPriorColdOutreach({
      deliveryMode: "dry_run",
      queueState: "scheduled",
      eventStates: [state],
    })).toBe(true);
  });

  it("counts a live provider submission", () => {
    expect(hasActualPriorColdOutreach({
      deliveryMode: "live",
      queueState: "provider_submitted",
      eventStates: [],
    })).toBe(true);
  });
});

describe("evaluateOutreachAttempt", () => {
  it("allows a fresh attempt with no history", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], []);
    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it("blocks a suppressed contact point", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], [{ contactPointId: "cp_owner", accountId: null }]);
    expect(decision).toEqual({ allowed: false, reason: "suppressed" });
  });

  it("blocks a normalized email suppressed through another contact-point ID", () => {
    const decision = canEnterColdOutreach(
      { ...baseContext, normalizedEmail: "owner@example.es" },
      [],
      [{ contactPointId: "cp_older", accountId: null, normalizedEmail: "owner@example.es" }],
    );
    expect(decision).toEqual({ allowed: false, reason: "suppressed" });
  });

  it("blocks a suppressed account regardless of contact point", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], [{ contactPointId: null, accountId: "acc_1" }]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("suppressed");
  });

  it("blocks prior outreach even when it was queued by another campaign", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_google_serp",
        channel: "email",
        createdAt: "2026-01-10T09:00:00.000Z",
        state: "sent",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = canEnterColdOutreach(baseContext, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "existing_outreach" });
  });

  it("blocks an email already contacted under another account in the same workspace", () => {
    const recent: RecentOutreachEvent[] = [{
      contactPointId: "cp_previous_account",
      accountId: "acc_previous",
      campaignId: "campaign_google_serp",
      channel: "email",
      createdAt: "2026-01-10T09:00:00.000Z",
      state: "sent",
      deliveryMode: "live",
      providerConfirmed: false,
      normalizedEmail: "owner@example.es",
    }];
    const decision = canEnterColdOutreach(
      { ...baseContext, accountId: "acc_new", contactPointId: "cp_new", normalizedEmail: "owner@example.es" },
      recent,
      [],
    );
    expect(decision).toEqual({ allowed: false, reason: "existing_outreach" });
  });

  it("does not automatically recontact after the default cooldown has elapsed", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2025-11-01T09:00:00.000Z",
        state: "sent",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = evaluateOutreachAttempt(baseContext, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "existing_outreach" });
  });

  it("allows recontact only when an explicit cooldown policy permits it", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2025-11-01T09:00:00.000Z",
        state: "sent",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = canEnterColdOutreach(baseContext, recent, [], {
      recontactPolicy: { cooldownHours: 24 * 30 },
    });
    expect(decision.allowed).toBe(true);
  });

  it("enforces the account-level concurrency lock (owner in flight blocks info@ attempt)", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-14T09:00:00.000Z",
        state: "delivered",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "account_concurrency_lock" });
  });

  it("does not block cold outreach on a scheduled dry-run row", () => {
    const recent: RecentOutreachEvent[] = [{
      contactPointId: "cp_owner",
      accountId: "acc_1",
      campaignId: "campaign_maps_fast",
      channel: "email",
      createdAt: "2026-01-14T09:00:00.000Z",
      state: "scheduled",
      deliveryMode: "dry_run",
      providerConfirmed: false,
    }];

    expect(canEnterColdOutreach(baseContext, recent, []).allowed).toBe(true);
  });

  it("blocks a contact point with prior bounced history by default", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-14T09:00:00.000Z",
        state: "bounced",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "existing_outreach" });
  });

  it("never re-enqueues an unsubscribed contact point", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2025-01-01T09:00:00.000Z",
        state: "unsubscribed",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    expect(canEnterColdOutreach(baseContext, recent, [])).toEqual({ allowed: false, reason: "existing_outreach" });
  });

  it("blocks active conversations and booked meetings", () => {
    expect(canEnterColdOutreach({ ...baseContext, hasActiveConversation: true }, [], []).reason).toBe("active_conversation");
    expect(canEnterColdOutreach({ ...baseContext, hasMeetingBooked: true }, [], []).reason).toBe("meeting_booked");
  });

  it("allows simultaneous account contacts only when an explicit recontact policy permits them", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-14T09:00:00.000Z",
        state: "delivered",
        deliveryMode: "live",
        providerConfirmed: false,
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, [], {
      allowSimultaneousAccountContacts: true,
      recontactPolicy: { cooldownHours: 0 },
    });
    expect(decision.allowed).toBe(true);
  });
});
