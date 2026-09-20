import { describe, expect, it } from "vitest";
import { evaluateOutreachAttempt, type RecentOutreachEvent } from "./outreach-dedup";

const baseContext = {
  contactPointId: "cp_owner",
  accountId: "acc_1",
  campaignId: "campaign_maps_fast",
  channel: "email" as const,
  now: "2026-01-15T09:00:00.000Z",
};

describe("evaluateOutreachAttempt", () => {
  it("allows a fresh attempt with no history", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], []);
    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it("blocks a suppressed contact point", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], [{ contactPointId: "cp_owner", accountId: null }]);
    expect(decision).toEqual({ allowed: false, reason: "suppressed" });
  });

  it("blocks a suppressed account regardless of contact point", () => {
    const decision = evaluateOutreachAttempt(baseContext, [], [{ contactPointId: null, accountId: "acc_1" }]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("suppressed");
  });

  it("blocks within the cooldown window for the same endpoint/campaign/channel", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-10T09:00:00.000Z",
        state: "sent",
      },
    ];
    const decision = evaluateOutreachAttempt(baseContext, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "cooldown_active" });
  });

  it("allows again once the cooldown has elapsed", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2025-11-01T09:00:00.000Z",
        state: "sent",
      },
    ];
    const decision = evaluateOutreachAttempt(baseContext, recent, []);
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
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, []);
    expect(decision).toEqual({ allowed: false, reason: "account_concurrency_lock" });
  });

  it("does not lock on a terminal (no-longer-in-flight) event", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-14T09:00:00.000Z",
        state: "bounced",
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, []);
    expect(decision.allowed).toBe(true);
  });

  it("allows simultaneous account contacts only when explicitly configured", () => {
    const recent: RecentOutreachEvent[] = [
      {
        contactPointId: "cp_owner",
        accountId: "acc_1",
        campaignId: "campaign_maps_fast",
        channel: "email",
        createdAt: "2026-01-14T09:00:00.000Z",
        state: "delivered",
      },
    ];
    const decision = evaluateOutreachAttempt({ ...baseContext, contactPointId: "cp_info" }, recent, [], {
      allowSimultaneousAccountContacts: true,
    });
    expect(decision.allowed).toBe(true);
  });
});
