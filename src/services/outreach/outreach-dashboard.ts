import type { OutreachEventState, OutreachQueueItem } from "@/domain/outreach/types";
import type { ContactPointType } from "@/domain/contacts/types";

export const OUTREACH_QUEUE_PAGE_SIZE = 25;

export const OUTREACH_QUEUE_TABS = {
  scheduled: ["scheduled", "queued", "provider_submitted"],
  sent: ["sent", "delivered"],
  replies: ["replied"],
  failed: ["failed", "bounced"],
  suppressed: ["suppressed", "unsubscribed", "canceled"],
} satisfies Record<string, OutreachEventState[]>;

export type OutreachQueueTab = keyof typeof OUTREACH_QUEUE_TABS;
export type OutreachQueueCursor = { id: string };
export interface OutreachQueueFilters {
  channel?: ContactPointType;
  campaignId?: string;
}

export interface OutreachQueueRow {
  item: OutreachQueueItem;
}

export interface OutreachQueuePage {
  items: OutreachQueueItem[];
  nextCursor: OutreachQueueCursor | null;
}

export interface OutreachQueueDisplayData {
  accounts: Array<{ id: string; canonicalName: string }>;
  contactPoints: Array<{ id: string; value: string }>;
}

export interface OutreachQueuePageData extends OutreachQueuePage, OutreachQueueDisplayData {}

export function mergeOutreachQueuePageData(
  current: OutreachQueuePageData,
  next: OutreachQueuePageData,
): OutreachQueuePageData {
  const mergeById = <T extends { id: string }>(left: T[], right: T[]) => {
    const merged = new Map(left.map((item) => [item.id, item]));
    for (const item of right) merged.set(item.id, item);
    return [...merged.values()];
  };
  return {
    items: mergeById(current.items, next.items),
    accounts: mergeById(current.accounts, next.accounts),
    contactPoints: mergeById(current.contactPoints, next.contactPoints),
    nextCursor: next.nextCursor,
  };
}

export interface OutreachQueuePageDependencies {
  listQueueRows(
    states: OutreachEventState[],
    limit: number,
    cursor: OutreachQueueCursor | null,
    filters: OutreachQueueFilters,
  ): Promise<OutreachQueueRow[]>;
}

export async function loadOutreachQueuePage(
  dependencies: OutreachQueuePageDependencies,
  tab: OutreachQueueTab,
  cursor: OutreachQueueCursor | null = null,
  filters: OutreachQueueFilters = {},
  pageSize = OUTREACH_QUEUE_PAGE_SIZE,
): Promise<OutreachQueuePage> {
  const rows = await dependencies.listQueueRows(OUTREACH_QUEUE_TABS[tab], pageSize + 1, cursor, filters);
  const hasMore = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const lastRow = visibleRows.at(-1);
  return {
    items: visibleRows.map(({ item }) => item),
    nextCursor: hasMore && lastRow ? { id: lastRow.item.id } : null,
  };
}

export interface OutreachQueueAggregate {
  state: OutreachEventState;
  channel?: string;
  total: number;
}

export interface OutreachKpis {
  sentToday: number;
  scheduledToday: number;
  emailCount: number;
  smsCount: number;
  bounces: number;
  replies: number;
  optOuts: number;
}

export interface OutreachDashboardData extends OutreachQueuePageData {
  campaigns: Array<{ id: string; name: string }>;
  kpis: OutreachKpis;
  senderPool: SenderPoolSummary;
}

export function calculateOutreachKpis(
  queueAggregates: OutreachQueueAggregate[],
  eventAggregates: OutreachQueueAggregate[],
): OutreachKpis {
  const queueCount = (predicate: (aggregate: OutreachQueueAggregate) => boolean) =>
    queueAggregates.reduce((total, aggregate) => total + (predicate(aggregate) ? aggregate.total : 0), 0);
  const eventCount = (state: OutreachEventState) =>
    eventAggregates.reduce((total, aggregate) => total + (aggregate.state === state ? aggregate.total : 0), 0);

  return {
    sentToday: queueCount(({ state }) => state === "sent" || state === "delivered"),
    scheduledToday: queueCount(({ state }) => state === "scheduled" || state === "queued"),
    emailCount: queueCount(({ channel }) => channel === "email"),
    smsCount: queueCount(({ channel }) => channel === "phone"),
    bounces: eventCount("bounced"),
    replies: eventCount("replied"),
    optOuts: eventCount("unsubscribed"),
  };
}

export interface SenderPoolAggregate {
  totalDailyCapacity: number;
  totalSentToday: number;
  totalRemainingCapacity: number;
  usableMailboxCount: number;
  totalMailboxCount: number;
}

export interface SenderPoolSummary {
  totalDailyCapacity: number;
  totalSentToday: number;
  totalRemainingCapacity: number;
  usableMailboxCount: number;
  pausedOrUnhealthyMailboxCount: number;
}

export function summarizeSenderPoolAggregate(aggregate: SenderPoolAggregate): SenderPoolSummary {
  return {
    totalDailyCapacity: aggregate.totalDailyCapacity,
    totalSentToday: aggregate.totalSentToday,
    totalRemainingCapacity: aggregate.totalRemainingCapacity,
    usableMailboxCount: aggregate.usableMailboxCount,
    pausedOrUnhealthyMailboxCount: aggregate.totalMailboxCount - aggregate.usableMailboxCount,
  };
}

export interface OutreachDashboardDependencies extends OutreachQueuePageDependencies {
  listQueueDisplayData(accountIds: string[], contactPointIds: string[]): Promise<OutreachQueueDisplayData>;
  listCampaignMetadata(): Promise<Array<{ id: string; name: string }>>;
  listQueueAggregates(): Promise<OutreachQueueAggregate[]>;
  listEventAggregates(): Promise<OutreachQueueAggregate[]>;
  getSenderPoolAggregate(): Promise<SenderPoolAggregate>;
}

export async function loadOutreachQueuePageData(
  dependencies: OutreachDashboardDependencies,
  tab: OutreachQueueTab,
  cursor: OutreachQueueCursor | null = null,
  filters: OutreachQueueFilters = {},
): Promise<OutreachQueuePageData> {
  const page = await loadOutreachQueuePage(dependencies, tab, cursor, filters);
  const accountIds = [...new Set(page.items.map((item) => item.accountId))];
  const contactPointIds = [...new Set(page.items.map((item) => item.contactPointId))];
  const displayData = page.items.length > 0
    ? await dependencies.listQueueDisplayData(accountIds, contactPointIds)
    : { accounts: [], contactPoints: [] };
  return { ...page, ...displayData };
}

export async function loadOutreachDashboardData(
  dependencies: OutreachDashboardDependencies,
): Promise<OutreachDashboardData> {
  const [queuePage, campaigns, queueAggregates, eventAggregates, senderPoolAggregate] = await Promise.all([
    loadOutreachQueuePageData(dependencies, "scheduled"),
    dependencies.listCampaignMetadata(),
    dependencies.listQueueAggregates(),
    dependencies.listEventAggregates(),
    dependencies.getSenderPoolAggregate(),
  ]);
  return {
    ...queuePage,
    campaigns,
    kpis: calculateOutreachKpis(queueAggregates, eventAggregates),
    senderPool: summarizeSenderPoolAggregate(senderPoolAggregate),
  };
}