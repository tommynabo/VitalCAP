import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, conversationMessages, setterDrafts, setterFeedback, meetings } from "../schema/conversations";
import type { Conversation, ConversationMessage, SetterDraft, SetterFeedback, Meeting } from "@/domain/conversations/types";

function toConversation(row: typeof conversations.$inferSelect): Conversation {
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

function toMessage(row: typeof conversationMessages.$inferSelect): ConversationMessage {
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

function toDraft(row: typeof setterDrafts.$inferSelect): SetterDraft {
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
    createdAt: row.createdAt.toISOString(),
  };
}

function toFeedback(row: typeof setterFeedback.$inferSelect): SetterFeedback {
  return {
    id: row.id,
    conversationMessageId: row.conversationMessageId,
    predictedBranch: row.predictedBranch as SetterFeedback["predictedBranch"],
    correctedBranch: row.correctedBranch as SetterFeedback["correctedBranch"],
    aiDraft: row.aiDraft,
    correctedText: row.correctedText,
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
