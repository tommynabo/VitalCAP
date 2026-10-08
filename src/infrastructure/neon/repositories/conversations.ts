import { and, asc, count, desc, eq, inArray, lt, min, or } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, conversationMessages, setterDrafts, setterFeedback, meetings } from "../schema/conversations";
import type { Conversation, ConversationMessage, SetterDraft, SetterFeedback, Meeting } from "@/domain/conversations/types";
import type { SetterQueueCursor, SetterQueueConversation, SetterQueueDraft, SetterQueueMessage } from "@/services/setter/review-queue";

export function toConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    contactId: row.contactId,
    campaignId: row.campaignId,
    offerId: row.offerId,
    channel: row.channel as Conversation["channel"],
    providerThreadId: row.providerThreadId,
    state: row.state as Conversation["state"],
    latestIntent: row.latestIntent as Conversation["latestIntent"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessage(row: typeof conversationMessages.$inferSelect): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction as ConversationMessage["direction"],
    body: row.body,
    channel: row.channel as ConversationMessage["channel"],
    providerMessageId: row.providerMessageId,
    metadata: row.metadata as ConversationMessage["metadata"],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDraft(row: typeof setterDrafts.$inferSelect): SetterDraft {
  return {
    id: row.id,
    conversationMessageId: row.conversationMessageId,
    language: row.language,
    branch: row.branch as SetterDraft["branch"],
    intentSummary: row.intentSummary,
    confidence: row.confidence,
    draft: row.draft,
    needsHuman: row.needsHuman,
    reasonForHuman: row.reasonForHuman,
    detectedFactsRequested: row.detectedFactsRequested as string[],
    riskFlags: row.riskFlags as string[],
    suggestedNextAction: row.suggestedNextAction,
    providerMetadata: row.providerMetadata as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toFeedback(row: typeof setterFeedback.$inferSelect): SetterFeedback {
  return {
    id: row.id,
    conversationMessageId: row.conversationMessageId,
    predictedBranch: row.predictedBranch as SetterFeedback["predictedBranch"],
    correctedBranch: row.correctedBranch as SetterFeedback["correctedBranch"],
    aiDraft: row.aiDraft,
    correctedText: row.correctedText,
    finalText: row.finalText,
    decision: row.decision as SetterFeedback["decision"],
    reasonCategory: row.reasonCategory,
    note: row.note,
    meetingOutcome: row.meetingOutcome,
    qualified: row.qualified,
    lostReason: row.lostReason,
    reviewedAt: row.reviewedAt.toISOString(),
    reviewerId: row.reviewerId,
  };
}

function toMeeting(row: typeof meetings.$inferSelect): Meeting {
  return {
    id: row.id,
    conversationId: row.conversationId,
    scheduledFor: row.scheduledFor.toISOString(),
    bookingUrl: row.bookingUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listConversations(workspaceId: string): Promise<Conversation[]> {
  const db = getDb();
  const rows = await db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId));
  return rows.map(toConversation);
}

export async function countPendingReviewConversations(workspaceId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: count() })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.state, "pending_review")));
  return row?.total ?? 0;
}

export async function getOldestPendingReviewAt(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ oldestAt: min(conversations.updatedAt) })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.state, "pending_review")));
  return row?.oldestAt?.toISOString() ?? null;
}

export async function listPendingReviewConversations(
  workspaceId: string,
  limit: number,
  cursor: SetterQueueCursor | null,
): Promise<SetterQueueConversation[]> {
  const db = getDb();
  const cursorDate = cursor ? new Date(cursor.updatedAt) : null;
  const conditions = [eq(conversations.workspaceId, workspaceId), eq(conversations.state, "pending_review")];
  if (cursor && cursorDate) {
    conditions.push(or(
      lt(conversations.updatedAt, cursorDate),
      and(eq(conversations.updatedAt, cursorDate), lt(conversations.id, cursor.id)),
    )!);
  }
  const rows = await db
    .select({
      id: conversations.id,
      accountId: conversations.accountId,
      contactId: conversations.contactId,
      campaignId: conversations.campaignId,
      state: conversations.state,
      latestIntent: conversations.latestIntent,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    state: row.state as Conversation["state"],
    latestIntent: row.latestIntent as Conversation["latestIntent"],
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listSetterQueueMessages(
  workspaceId: string,
  conversationIds: string[],
): Promise<SetterQueueMessage[]> {
  if (conversationIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: conversationMessages.id,
      conversationId: conversationMessages.conversationId,
      direction: conversationMessages.direction,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), inArray(conversations.id, conversationIds)))
    .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
  return rows.map((row) => ({
    ...row,
    direction: row.direction as ConversationMessage["direction"],
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listLatestIncomingSetterQueueMessages(
  workspaceId: string,
  conversationIds: string[],
): Promise<SetterQueueMessage[]> {
  if (conversationIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .selectDistinctOn([conversationMessages.conversationId], {
      id: conversationMessages.id,
      conversationId: conversationMessages.conversationId,
      direction: conversationMessages.direction,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(and(
      eq(conversations.workspaceId, workspaceId),
      inArray(conversations.id, conversationIds),
      eq(conversationMessages.direction, "incoming"),
    ))
    .orderBy(asc(conversationMessages.conversationId), desc(conversationMessages.createdAt), desc(conversationMessages.id));
  return rows.map((row) => ({
    ...row,
    direction: row.direction as ConversationMessage["direction"],
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listSetterQueueDrafts(
  workspaceId: string,
  inboundMessageIds: string[],
): Promise<SetterQueueDraft[]> {
  if (inboundMessageIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: setterDrafts.id,
      conversationMessageId: setterDrafts.conversationMessageId,
      draft: setterDrafts.draft,
      confidence: setterDrafts.confidence,
      riskFlags: setterDrafts.riskFlags,
    })
    .from(setterDrafts)
    .innerJoin(conversationMessages, eq(setterDrafts.conversationMessageId, conversationMessages.id))
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), inArray(conversationMessages.id, inboundMessageIds)));
  return rows.map((row) => ({ ...row, riskFlags: row.riskFlags as string[] }));
}

export async function listConversationMessages(workspaceId: string): Promise<ConversationMessage[]> {
  const db = getDb();
  const rows = await db
    .select({ message: conversationMessages })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(eq(conversations.workspaceId, workspaceId));
  return rows.map(({ message }) => toMessage(message));
}

export async function listSetterDrafts(workspaceId: string): Promise<SetterDraft[]> {
  const db = getDb();
  const rows = await db
    .select({ draft: setterDrafts })
    .from(setterDrafts)
    .innerJoin(conversationMessages, eq(setterDrafts.conversationMessageId, conversationMessages.id))
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(eq(conversations.workspaceId, workspaceId));
  return rows.map(({ draft }) => toDraft(draft));
}

export async function listSetterFeedback(workspaceId: string): Promise<SetterFeedback[]> {
  const db = getDb();
  const rows = await db
    .select({ feedback: setterFeedback })
    .from(setterFeedback)
    .innerJoin(conversationMessages, eq(setterFeedback.conversationMessageId, conversationMessages.id))
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(eq(conversations.workspaceId, workspaceId));
  return rows.map(({ feedback }) => toFeedback(feedback));
}

export async function listMeetings(workspaceId: string): Promise<Meeting[]> {
  const db = getDb();
  const rows = await db
    .select({ meeting: meetings })
    .from(meetings)
    .innerJoin(conversations, eq(meetings.conversationId, conversations.id))
    .where(eq(conversations.workspaceId, workspaceId));
  return rows.map(({ meeting }) => toMeeting(meeting));
}
