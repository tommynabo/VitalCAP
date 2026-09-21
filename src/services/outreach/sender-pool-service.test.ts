import { describe, expect, it } from "vitest";
import type { Mailbox, SendingDomain } from "@/domain/outreach/types";
import {
  isMailboxUsable,
  mailboxRemainingCapacity,
  selectMailboxForSend,
  summarizeSenderPoolCapacity,
} from "./sender-pool-service";

function domain(overrides: Partial<SendingDomain> = {}): SendingDomain {
  return { id: "dom_1", domain: "example.com", status: "connected", warmupStatus: "warm", ...overrides };
}

function mailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mb_1",
    sendingDomainId: "dom_1",
    email: "sales@example.com",
    dailyCapacity: 30,
    sentToday: 10,
    bounceRate: 0.01,
    replyRate: 0.05,
    healthScore: 90,
    pausedReason: null,
    ...overrides,
  };
}

describe("mailboxRemainingCapacity", () => {
  it("computes capacity minus sent, never negative", () => {
    expect(mailboxRemainingCapacity(mailbox({ dailyCapacity: 30, sentToday: 10 }))).toBe(20);
    expect(mailboxRemainingCapacity(mailbox({ dailyCapacity: 30, sentToday: 45 }))).toBe(0);
  });
});

describe("isMailboxUsable", () => {
  it("is unusable when explicitly paused", () => {
    expect(isMailboxUsable(mailbox({ pausedReason: "manual pause" }), domain())).toBe(false);
  });

  it("is unusable when the parent sending domain is paused or missing configuration", () => {
    expect(isMailboxUsable(mailbox(), domain({ status: "paused" }))).toBe(false);
    expect(isMailboxUsable(mailbox(), domain({ status: "missing_configuration" }))).toBe(false);
  });

  it("is unusable above the bounce-rate or below the health-score threshold", () => {
    expect(isMailboxUsable(mailbox({ bounceRate: 0.2 }), domain())).toBe(false);
    expect(isMailboxUsable(mailbox({ healthScore: 10 }), domain())).toBe(false);
  });

  it("is unusable when there is no remaining capacity", () => {
    expect(isMailboxUsable(mailbox({ dailyCapacity: 10, sentToday: 10 }), domain())).toBe(false);
  });

  it("is usable when connected/degraded, healthy and has capacity", () => {
    expect(isMailboxUsable(mailbox(), domain())).toBe(true);
    expect(isMailboxUsable(mailbox(), domain({ status: "degraded" }))).toBe(true);
  });
});

describe("selectMailboxForSend", () => {
  it("picks the usable mailbox with the most remaining capacity", () => {
    const domains = [domain()];
    const mailboxes = [
      mailbox({ id: "mb_low", sentToday: 25 }),
      mailbox({ id: "mb_high", sentToday: 5 }),
    ];
    const selected = selectMailboxForSend({ mailboxes, sendingDomains: domains });
    expect(selected?.id).toBe("mb_high");
  });

  it("returns null when no mailbox in the pool is usable", () => {
    const selected = selectMailboxForSend({
      mailboxes: [mailbox({ pausedReason: "paused" })],
      sendingDomains: [domain()],
    });
    expect(selected).toBeNull();
  });
});

describe("summarizeSenderPoolCapacity", () => {
  it("aggregates capacity and separates usable from paused/unhealthy mailboxes", () => {
    const domains = [domain()];
    const mailboxes = [mailbox({ id: "mb_1", dailyCapacity: 30, sentToday: 10 }), mailbox({ id: "mb_2", pausedReason: "paused" })];
    const summary = summarizeSenderPoolCapacity({ mailboxes, sendingDomains: domains });
    expect(summary.totalRemainingCapacity).toBe(20);
    expect(summary.usableMailboxCount).toBe(1);
    expect(summary.pausedOrUnhealthyMailboxCount).toBe(1);
  });
});
