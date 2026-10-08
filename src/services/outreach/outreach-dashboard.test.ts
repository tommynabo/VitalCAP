import { describe, expect, it, vi } from "vitest";
import type { OutreachQueueRow } from "./outreach-dashboard";
import {
  calculateOutreachKpis,
  loadOutreachDashboardData,
  loadOutreachQueuePage,
  mergeOutreachQueuePageData,
  summarizeSenderPoolAggregate,
  type OutreachDashboardDependencies,
} from "./outreach-dashboard";

function makeQueueRow(index: number, state: "queued" | "sent" = "queued"): OutreachQueueRow {
  return {
    item: {
      id: `queue-${index}`,
      campaignId: "campaign-1",
      accountId: `account-${index}`,
      contactId: null,
      contactPointId: `point-${index}`,
      channel: index % 2 === 0 ? "email" : "phone",
      priority: 1,
      scheduledFor: null,
      state,
      deliveryMode: "dry_run",
    },
  };
}

describe("Outreach dashboard data", () => {
  it("loads only the default tab with one cursor sentinel and returns a stable cursor", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => makeQueueRow(index));
    const listQueueRows = vi.fn(async () => rows);
    const page = await loadOutreachQueuePage({ listQueueRows }, "scheduled");

    expect(listQueueRows).toHaveBeenCalledWith(["scheduled", "queued", "provider_submitted"], 26, null, {});
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toEqual({ id: "queue-24" });
  });

  it("forwards a cursor when loading a subsequent page", async () => {
    const cursor = { id: "queue-24" };
    const listQueueRows = vi.fn(async () => [makeQueueRow(25)]);
    const page = await loadOutreachQueuePage({ listQueueRows }, "scheduled", cursor);

    expect(listQueueRows).toHaveBeenCalledWith(["scheduled", "queued", "provider_submitted"], 26, cursor, {});
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("preserves existing KPI semantics from grouped queue and event counts", () => {
    const kpis = calculateOutreachKpis(
      [
        { state: "sent", channel: "email", total: 3 },
        { state: "delivered", channel: "phone", total: 2 },
        { state: "queued", channel: "email", total: 4 },
        { state: "scheduled", channel: "phone", total: 5 },
        { state: "provider_submitted", channel: "email", total: 7 },
      ],
      [
        { state: "bounced", total: 6 },
        { state: "replied", total: 8 },
        { state: "unsubscribed", total: 9 },
      ],
    );

    expect(kpis).toEqual({
      sentToday: 5,
      scheduledToday: 9,
      emailCount: 14,
      smsCount: 7,
      bounces: 6,
      replies: 8,
      optOuts: 9,
    });
  });

  it("applies existing campaign and channel filters before the page limit", async () => {
    const listQueueRows = vi.fn(async () => []);
    await loadOutreachQueuePage({ listQueueRows }, "scheduled", null, { campaignId: "campaign-1", channel: "email" });

    expect(listQueueRows).toHaveBeenCalledWith(
      ["scheduled", "queued", "provider_submitted"],
      26,
      null,
      { campaignId: "campaign-1", channel: "email" },
    );
  });

  it("preserves the visible sender-health summary from compact database aggregates", () => {
    expect(summarizeSenderPoolAggregate({
      totalDailyCapacity: 60,
      totalSentToday: 22,
      totalRemainingCapacity: 18,
      usableMailboxCount: 2,
      totalMailboxCount: 5,
    })).toEqual({
      totalDailyCapacity: 60,
      totalSentToday: 22,
      totalRemainingCapacity: 18,
      usableMailboxCount: 2,
      pausedOrUnhealthyMailboxCount: 3,
    });
  });

  it("scopes account display data to only the initial page rows and never requests event history", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => makeQueueRow(index));
    const dependencies: OutreachDashboardDependencies = {
      listQueueRows: vi.fn(async (_states, limit) => rows.slice(0, limit)),
      listQueueDisplayData: vi.fn(async (accountIds: string[], contactPointIds: string[]) => ({
        accounts: accountIds.map((id) => ({ id, canonicalName: id })),
        contactPoints: contactPointIds.map((id) => ({ id, value: id })),
      })),
      listCampaignMetadata: vi.fn(async () => [{ id: "campaign-1", name: "Campaign 1" }]),
      listQueueAggregates: vi.fn(async () => [{ state: "queued" as const, channel: "email", total: 26 }]),
      listEventAggregates: vi.fn(async () => [{ state: "replied" as const, total: 4 }]),
      getSenderPoolAggregate: vi.fn(async () => ({
        totalDailyCapacity: 0,
        totalSentToday: 0,
        totalRemainingCapacity: 0,
        usableMailboxCount: 0,
        totalMailboxCount: 0,
      })),
    };
    const dashboard = await loadOutreachDashboardData(dependencies);

    expect(dependencies.listQueueDisplayData).toHaveBeenCalledWith(
      rows.slice(0, 25).map(({ item }) => item.accountId),
      rows.slice(0, 25).map(({ item }) => item.contactPointId),
    );
    expect(dependencies.listEventAggregates).toHaveBeenCalledTimes(1);
    expect(dashboard.items).toHaveLength(25);
    expect(dashboard.kpis.replies).toBe(4);
    expect(dashboard.nextCursor).toEqual({ id: "queue-24" });
  });

  it("keeps empty queue pages safe and does not query display rows", async () => {
    const dependencies: OutreachDashboardDependencies = {
      listQueueRows: vi.fn(async () => []),
      listQueueDisplayData: vi.fn(async () => ({ accounts: [], contactPoints: [] })),
      listCampaignMetadata: vi.fn(async () => []),
      listQueueAggregates: vi.fn(async () => []),
      listEventAggregates: vi.fn(async () => []),
      getSenderPoolAggregate: vi.fn(async () => ({
        totalDailyCapacity: 0,
        totalSentToday: 0,
        totalRemainingCapacity: 0,
        usableMailboxCount: 0,
        totalMailboxCount: 0,
      })),
    };
    const dashboard = await loadOutreachDashboardData(dependencies);

    expect(dashboard.items).toEqual([]);
    expect(dashboard.accounts).toEqual([]);
    expect(dashboard.contactPoints).toEqual([]);
    expect(dashboard.nextCursor).toBeNull();
    expect(dependencies.listQueueDisplayData).not.toHaveBeenCalled();
  });

  it("merges cursor pages without duplicating rows or display data", () => {
    const first = {
      items: [makeQueueRow(1).item],
      accounts: [{ id: "account-1", canonicalName: "Account 1" }],
      contactPoints: [{ id: "point-1", value: "one@example.com" }],
      nextCursor: { id: "queue-1" },
    };
    const next = {
      items: [makeQueueRow(1).item, makeQueueRow(2).item],
      accounts: [{ id: "account-2", canonicalName: "Account 2" }],
      contactPoints: [{ id: "point-2", value: "two@example.com" }],
      nextCursor: null,
    };

    const merged = mergeOutreachQueuePageData(first, next);
    expect(merged.items.map(({ id }) => id)).toEqual(["queue-1", "queue-2"]);
    expect(merged.accounts).toHaveLength(2);
    expect(merged.contactPoints).toHaveLength(2);
    expect(merged.nextCursor).toBeNull();
  });
});