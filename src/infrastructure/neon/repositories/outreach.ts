import { eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  outreachQueue,
  outreachEvents,
  sendingDomains,
  mailboxes,
  suppressionEntries,
} from "../schema/outreach";
import { campaigns } from "../schema/campaigns";
import type { OutreachQueueItem, OutreachEvent, SendingDomain, Mailbox, SuppressionEntry } from "@/domain/outreach/types";

function toQueueItem(row: typeof outreachQueue.$inferSelect): OutreachQueueItem {
  return {
    id: row.id,
    campaignId: row.campaignId,
    accountId: row.accountId,
    contactId: row.contactId,
    contactPointId: row.contactPointId,
    channel: row.channel as OutreachQueueItem["channel"],
    priority: row.priority,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    state: row.state as OutreachQueueItem["state"],
    deliveryMode: row.deliveryMode as OutreachQueueItem["deliveryMode"],
  };
}

function toEvent(row: typeof outreachEvents.$inferSelect): OutreachEvent {
  return {
    id: row.id,
    outreachQueueItemId: row.outreachQueueItemId,
    state: row.state as OutreachEvent["state"],
    providerEventId: row.providerEventId,
    payloadHash: row.payloadHash,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function toSendingDomain(row: typeof sendingDomains.$inferSelect): SendingDomain {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status as SendingDomain["status"],
    warmupStatus: row.warmupStatus as SendingDomain["warmupStatus"],
  };
}

function toMailbox(row: typeof mailboxes.$inferSelect): Mailbox {
  return {
    id: row.id,
    sendingDomainId: row.sendingDomainId,
    email: row.email,
    dailyCapacity: row.dailyCapacity,
    sentToday: row.sentToday,
    bounceRate: row.bounceRate,
    replyRate: row.replyRate,
    healthScore: row.healthScore,
    pausedReason: row.pausedReason,
  };
}

function toSuppressionEntry(row: typeof suppressionEntries.$inferSelect): SuppressionEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contactPointId: row.contactPointId,
    accountId: row.accountId,
    reason: row.reason as SuppressionEntry["reason"],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listOutreachQueueItems(workspaceId: string): Promise<OutreachQueueItem[]> {
  const db = getDb();
  const rows = await db
    .select({ item: outreachQueue })
    .from(outreachQueue)
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(({ item }) => toQueueItem(item));
}

export async function listOutreachEvents(workspaceId: string): Promise<OutreachEvent[]> {
  const db = getDb();
  const rows = await db
    .select({ event: outreachEvents })
    .from(outreachEvents)
    .innerJoin(outreachQueue, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(({ event }) => toEvent(event));
}

export async function listSendingDomains(workspaceId: string): Promise<SendingDomain[]> {
  const db = getDb();
  const rows = await db.select().from(sendingDomains).where(eq(sendingDomains.workspaceId, workspaceId));
  return rows.map(toSendingDomain);
}

export async function listMailboxes(workspaceId: string): Promise<Mailbox[]> {
  const db = getDb();
  const rows = await db
    .select({ mailbox: mailboxes })
    .from(mailboxes)
    .innerJoin(sendingDomains, eq(mailboxes.sendingDomainId, sendingDomains.id))
    .where(eq(sendingDomains.workspaceId, workspaceId));
  return rows.map(({ mailbox }) => toMailbox(mailbox));
}

export async function listSuppressionEntries(workspaceId: string): Promise<SuppressionEntry[]> {
  const db = getDb();
  const rows = await db.select().from(suppressionEntries).where(eq(suppressionEntries.workspaceId, workspaceId));
  return rows.map(toSuppressionEntry);
}
