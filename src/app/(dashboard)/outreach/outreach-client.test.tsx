import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutreachClient } from "./outreach-client";
import type { OutreachDashboardData } from "@/services/outreach/outreach-dashboard";

const initialData: OutreachDashboardData = {
  items: [{
    id: "queue-1",
    campaignId: "campaign-1",
    accountId: "account-1",
    contactId: null,
    contactPointId: "point-1",
    channel: "email",
    priority: 5,
    scheduledFor: "2026-10-08T12:00:00.000Z",
    state: "scheduled",
    deliveryMode: "dry_run",
  }],
  nextCursor: null,
  accounts: [{ id: "account-1", canonicalName: "Example Account" }],
  contactPoints: [{ id: "point-1", value: "sales@example.com" }],
  campaigns: [{ id: "campaign-1", name: "Example Campaign" }],
  kpis: {
    sentToday: 2,
    scheduledToday: 3,
    emailCount: 4,
    smsCount: 5,
    bounces: 6,
    replies: 7,
    optOuts: 8,
  },
  senderPool: {
    totalDailyCapacity: 30,
    totalSentToday: 10,
    totalRemainingCapacity: 20,
    usableMailboxCount: 1,
    pausedOrUnhealthyMailboxCount: 2,
  },
};

describe("OutreachClient", () => {
  it("preserves visible KPI, sender-health, filter, and queue labels with compact props", () => {
    const markup = renderToStaticMarkup(createElement(OutreachClient, { initialData }));

    expect(markup).toContain("Scheduled today");
    expect(markup).toContain("Sent today");
    expect(markup).toContain("Email / SMS");
    expect(markup).toContain("Bounces");
    expect(markup).toContain("Replies");
    expect(markup).toContain("Opt-outs");
    expect(markup).toContain("Usable mailboxes");
    expect(markup).toContain("Remaining capacity");
    expect(markup).toContain("Paused / unhealthy");
    expect(markup).toContain("All channels");
    expect(markup).toContain("All campaigns");
    expect(markup).toContain("Example Account");
    expect(markup).toContain("sales@example.com");
    expect(markup).toContain("Example Campaign");
  });

  it("renders an empty initial queue safely", () => {
    const markup = renderToStaticMarkup(createElement(OutreachClient, {
      initialData: { ...initialData, items: [], accounts: [], contactPoints: [], nextCursor: null },
    }));

    expect(markup).toContain("No queue items in this bucket.");
    expect(markup).toContain("Outreach queue");
  });
});