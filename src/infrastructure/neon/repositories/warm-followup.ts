import { and, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, conversationMessages, meetings, warmFollowupQueue } from "../schema/conversations";
import type { SetterBranch } from "@/domain/conversations/types";
import type { WarmFollowupQueueItem, WarmFollowupStatus, WarmFollowupPauseTrigger } from "@/services/setter/warm-followup-service";

const WARM_ELIGIBLE_BRANCHES: readonly SetterBranch[] = ["INTEREST", "SEND_INFO", "CALL_ME_LATER", "PRODUCT_DETAILS", "SAMPLES"];

function toWarmFollowupItem(row: typeof warmFollowupQueue.$inferSelect): WarmFollowupQueueItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    enteredAt: row.enteredAt.toISOString(),
    status: row.status as WarmFollowupStatus,
    pauseReason: row.pauseReason as WarmFollowupPauseTrigger | null,
    nextFollowupAt: row.nextFollowupAt?.toISOString() ?? null,
  };
}

export interface WarmFollowupEntryCandidate {
  conversationId: string;
  branch: SetterBranch;
  channel: string;
}

/**
 * Conversations whose `latestIntent` is warm-eligible, have no meeting
 * booked yet, and have no `warm_followup_queue` row yet — feeds
 * `enterWarmFollowupQueue` (pure) one row at a time (Gate E warm-followup
 * cron, entry phase).
 */
export async function listWarmFollowupEntryCandidates(workspaceId: string, limit: number): Promise<WarmFollowupEntryCandidate[]> {
  const db = getDb();
  const rows = await db
    .select({ conversationId: conversations.id, branch: conversations.latestIntent, channel: conversations.channel })
    .from(conversations)
    .leftJoin(warmFollowupQueue, eq(warmFollowupQueue.conversationId, conversations.id))
    .leftJoin(meetings, eq(meetings.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        inArray(conversations.latestIntent, WARM_ELIGIBLE_BRANCHES),
        isNull(warmFollowupQueue.id),
        isNull(meetings.id),
      ),
    )
    .limit(limit);

  return rows
    .filter((row): row is { conversationId: string; branch: string; channel: string } => row.branch !== null)
    .map((row) => ({ conversationId: row.conversationId, branch: row.branch as SetterBranch, channel: row.channel }));
}

export async function insertWarmFollowupQueueItem(item: WarmFollowupQueueItem): Promise<void> {
  const db = getDb();
  await db.insert(warmFollowupQueue).values({
    id: item.id,
    conversationId: item.conversationId,
    enteredAt: new Date(item.enteredAt),
    status: item.status,
    pauseReason: item.pauseReason,
    nextFollowupAt: item.nextFollowupAt ? new Date(item.nextFollowupAt) : null,
  });
}

export async function updateWarmFollowupQueueItem(item: WarmFollowupQueueItem): Promise<void> {
  const db = getDb();
  await db
    .update(warmFollowupQueue)
    .set({
      status: item.status,
      pauseReason: item.pauseReason,
      nextFollowupAt: item.nextFollowupAt ? new Date(item.nextFollowupAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(warmFollowupQueue.id, item.id));
}

export interface WarmFollowupTriggerCheckRow {
  item: WarmFollowupQueueItem;
  hasReplySinceEntered: boolean;
  hasMeetingBooked: boolean;
}

/** Every `status = 'active'` item for a workspace, plus the two facts needed to decide whether a pause/complete trigger fires (Gate E warm-followup cron, trigger phase). Only "reply" and "meeting" are derivable from existing schema — "unsubscribe"/"human_ownership" require an explicit operator action with no UI wired yet (documented gap, not invented here). */
export async function listActiveWarmFollowupsForTriggerCheck(workspaceId: string, limit: number): Promise<WarmFollowupTriggerCheckRow[]> {
  const db = getDb();
  const rows = await db
    .select({ item: warmFollowupQueue })
    .from(warmFollowupQueue)
    .innerJoin(conversations, eq(warmFollowupQueue.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(warmFollowupQueue.status, "active")))
    .limit(limit);

  const results: WarmFollowupTriggerCheckRow[] = [];
  for (const row of rows) {
    const item = toWarmFollowupItem(row.item);
    const [reply] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, item.conversationId),
          eq(conversationMessages.direction, "incoming"),
          gt(conversationMessages.createdAt, new Date(item.enteredAt)),
        ),
      )
      .limit(1);
    const [meeting] = await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.conversationId, item.conversationId)).limit(1);
    results.push({ item, hasReplySinceEntered: Boolean(reply), hasMeetingBooked: Boolean(meeting) });
  }
  return results;
}

export interface DueWarmFollowup {
  item: WarmFollowupQueueItem;
  channel: string;
}

/** `status = 'active'` items due for dispatch now (Gate E warm-followup cron, dispatch phase). */
export async function listDueWarmFollowups(workspaceId: string, now: Date, limit: number): Promise<DueWarmFollowup[]> {
  const db = getDb();
  const rows = await db
    .select({ item: warmFollowupQueue, channel: conversations.channel })
    .from(warmFollowupQueue)
    .innerJoin(conversations, eq(warmFollowupQueue.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(warmFollowupQueue.status, "active"),
        lte(warmFollowupQueue.nextFollowupAt, now),
      ),
    )
    .orderBy(desc(warmFollowupQueue.nextFollowupAt))
    .limit(limit);
  return rows.map(({ item, channel }) => ({ item: toWarmFollowupItem(item), channel }));
}

/** Records a dry-run outgoing warm-followup message. Never sent to any real provider — `metadata.deliveryMode` is always `"dry_run"`, matching the standing "no live outreach" constraint. */
export async function insertDryRunWarmFollowupMessage(conversationId: string, channel: string, body: string): Promise<void> {
  const db = getDb();
  await db.insert(conversationMessages).values({
    conversationId,
    direction: "outgoing",
    body,
    channel,
    metadata: { kind: "warm_followup", deliveryMode: "dry_run" },
  });
}

