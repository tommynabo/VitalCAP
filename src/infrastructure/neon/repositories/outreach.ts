import { and, eq, gte, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  outreachQueue,
  outreachEvents,
  sendingDomains,
  mailboxes,
  suppressionEntries,
} from "../schema/outreach";
import { campaigns, campaignMemberships } from "../schema/campaigns";
import { accounts } from "../schema/accounts";
import { contactPoints } from "../schema/contacts";
import { toContactPoint } from "./accounts";
import { complianceDecisions } from "../schema/compliance";
import { conversations, meetings } from "../schema/conversations";
import type { OutreachQueueItem, OutreachEvent, OutreachEventState, SendingDomain, Mailbox, SuppressionEntry } from "@/domain/outreach/types";
import type { ContactPoint } from "@/domain/contacts/types";
import type { OutreachCandidate } from "@/services/outreach/outreach-orchestrator";
import type { MixChannel } from "@/services/outreach/channel-mix-planner";
import { canEnterColdOutreach as evaluateColdOutreach } from "@/services/deduplication/outreach-dedup";

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

export async function canEnqueueColdOutreach(workspaceId: string, item: OutreachQueueItem, now: Date): Promise<boolean> {
  const db = getDb();
  const [contactPoint] = await db
    .select({ normalizedValue: contactPoints.normalizedValue })
    .from(contactPoints)
    .where(and(eq(contactPoints.id, item.contactPointId), eq(contactPoints.workspaceId, workspaceId)))
    .limit(1);
  if (!contactPoint) return false;

  const [suppressionRows, outreachRows, conversationRows, meetingRows] = await Promise.all([
    db.select({
      contactPointId: suppressionEntries.contactPointId,
      accountId: suppressionEntries.accountId,
      normalizedEmail: contactPoints.normalizedValue,
    })
      .from(suppressionEntries)
      .leftJoin(contactPoints, eq(suppressionEntries.contactPointId, contactPoints.id))
      .where(and(
        eq(suppressionEntries.workspaceId, workspaceId),
        or(
          eq(suppressionEntries.accountId, item.accountId),
          eq(suppressionEntries.contactPointId, item.contactPointId),
          and(eq(contactPoints.type, "email"), eq(contactPoints.normalizedValue, contactPoint.normalizedValue.toLowerCase())),
        ),
      )),
    db.select({
      contactPointId: outreachQueue.contactPointId,
      accountId: outreachQueue.accountId,
      campaignId: outreachQueue.campaignId,
      channel: outreachQueue.channel,
      createdAt: outreachQueue.createdAt,
      queueState: outreachQueue.state,
      eventState: outreachEvents.state,
      normalizedValue: contactPoints.normalizedValue,
    })
      .from(outreachQueue)
      .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
      .innerJoin(contactPoints, eq(outreachQueue.contactPointId, contactPoints.id))
      .leftJoin(outreachEvents, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
      .where(and(
        eq(campaigns.workspaceId, workspaceId),
        or(
          eq(outreachQueue.accountId, item.accountId),
          eq(outreachQueue.contactPointId, item.contactPointId),
          and(eq(outreachQueue.channel, "email"), eq(contactPoints.normalizedValue, contactPoint.normalizedValue.toLowerCase())),
        ),
      )),
    db.select({ state: conversations.state })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.accountId, item.accountId))),
    db.select({ id: meetings.id })
      .from(meetings)
      .innerJoin(conversations, eq(meetings.conversationId, conversations.id))
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.accountId, item.accountId)))
      .limit(1),
  ]);

  const hasActiveConversation = conversationRows.some(({ state }) => !["rejected", "no_reply_needed", "suppressed"].includes(state));
  return evaluateColdOutreach(
    {
      contactPointId: item.contactPointId,
      accountId: item.accountId,
      campaignId: item.campaignId,
      channel: item.channel,
      normalizedEmail: item.channel === "email" ? contactPoint.normalizedValue.toLowerCase() : null,
      hasActiveConversation,
      hasMeetingBooked: meetingRows.length > 0,
      now: now.toISOString(),
    },
    outreachRows.map((row) => ({
      contactPointId: row.contactPointId,
      accountId: row.accountId,
      campaignId: row.campaignId,
      channel: row.channel as OutreachQueueItem["channel"],
      createdAt: row.createdAt.toISOString(),
      state: (row.eventState ?? row.queueState) as OutreachEventState,
      normalizedEmail: row.normalizedValue.toLowerCase(),
    })),
    suppressionRows.map((row) => ({
      ...row,
      normalizedEmail: row.normalizedEmail?.toLowerCase() ?? null,
    })),
  ).allowed;
}

export async function insertOutreachQueueItem(workspaceId: string, item: OutreachQueueItem): Promise<boolean> {
  const db = getDb();
  const [contactPoint] = await db
    .select({ normalizedValue: contactPoints.normalizedValue, type: contactPoints.type })
    .from(contactPoints)
    .where(and(
      eq(contactPoints.id, item.contactPointId),
      eq(contactPoints.workspaceId, workspaceId),
      eq(contactPoints.accountId, item.accountId),
    ))
    .limit(1);
  if (!contactPoint) return false;

  const [inserted] = await db.insert(outreachQueue).values({
    workspaceId,
    id: item.id,
    campaignId: item.campaignId,
    accountId: item.accountId,
    contactId: item.contactId,
    contactPointId: item.contactPointId,
    normalizedEmail: item.channel === "email" && contactPoint.type === "email"
      ? contactPoint.normalizedValue.toLowerCase()
      : null,
    channel: item.channel,
    priority: item.priority,
    scheduledFor: item.scheduledFor ? new Date(item.scheduledFor) : null,
    state: item.state,
    deliveryMode: item.deliveryMode,
  }).onConflictDoNothing().returning({ id: outreachQueue.id });
  return Boolean(inserted);
}

export async function insertOutreachEvent(event: OutreachEvent): Promise<void> {
  const db = getDb();
  await db.insert(outreachEvents).values({
    id: event.id,
    outreachQueueItemId: event.outreachQueueItemId,
    state: event.state,
    providerEventId: event.providerEventId,
    payloadHash: event.payloadHash,
    occurredAt: new Date(event.occurredAt),
  });
}

/**
 * Builds `OutreachOrchestrator` candidates from campaign memberships already
 * at `stage = 'ready'` — the membership → contact-point join the pure
 * orchestrator itself is agnostic to how it was sourced. Each candidate
 * carries every contact point on its account (not just the membership's
 * `selectedContactPointId`) so `routeAccountToEndpoint` can still pick the
 * best eligible one per its own rules.
 */
export async function listOutreachCandidatesForCampaign(campaignId: string, limit: number): Promise<OutreachCandidate[]> {
  const db = getDb();
  const memberships = await db
    .select({ accountId: campaignMemberships.accountId, accountName: accounts.canonicalName, contactId: campaignMemberships.contactId, selectedContactPointId: campaignMemberships.selectedContactPointId })
    .from(campaignMemberships)
    .innerJoin(accounts, eq(campaignMemberships.accountId, accounts.id))
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(
        eq(campaignMemberships.campaignId, campaignId),
        eq(campaignMemberships.stage, "ready"),
        eq(campaigns.status, "active")
      )
    )
    .limit(limit);

  if (memberships.length === 0) return [];

  const candidates: OutreachCandidate[] = [];
  for (const membership of memberships) {
    if (!membership.selectedContactPointId) continue;
    const points = await db.select().from(contactPoints).where(eq(contactPoints.id, membership.selectedContactPointId));
    
    // Check if at least one contact point has an "allowed" compliance decision
    const allowedDecisions = await db
      .select()
      .from(complianceDecisions)
      .where(
        and(
          eq(complianceDecisions.accountId, membership.accountId),
          eq(complianceDecisions.campaignId, campaignId),
          eq(complianceDecisions.contactPointId, membership.selectedContactPointId),
          eq(complianceDecisions.decision, "allowed"),
          sql`superseded_at IS NULL`
        )
      );

    if (allowedDecisions.length === 0) {
      continue; // Skip if no contact point is actually allowed
    }

    candidates.push({
      accountId: membership.accountId,
      campaignId,
      contactPoints: points.map(toContactPoint),
      contactFirstName: null,
      accountName: membership.accountName,
    });
  }
  return candidates;
}

/** Per-channel sent-today counts for the mix planner — mirrors the `readyToday`/`sentToday` aggregation style already used in `autopilot.ts`. */
export async function getSentTodayByChannel(campaignId: string): Promise<Record<MixChannel, number>> {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const rows = await db
    .select({ channel: outreachQueue.channel })
    .from(outreachEvents)
    .innerJoin(outreachQueue, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
    .where(and(eq(outreachQueue.campaignId, campaignId), eq(outreachEvents.state, "sent"), gte(outreachEvents.occurredAt, startOfDay)));

  const counts: Record<MixChannel, number> = { email: 0, sms: 0 };
  for (const row of rows) {
    if (row.channel === "email") counts.email += 1;
    else if (row.channel === "phone") counts.sms += 1;
  }
  return counts;
}
