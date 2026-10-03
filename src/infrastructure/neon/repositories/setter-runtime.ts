import { and, desc, eq, or, sql } from "drizzle-orm";
import type { InboundEmailReply } from "@/domain/providers/types";
import type { Conversation, ConversationMessage, SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import type { ProcessIncomingReplyResult } from "@/services/setter/setter-orchestrator";
import type { PersistedInboundReply, SetterInboundContext, SetterInboundRuntimeStore } from "@/services/setter/inbound-runtime";
import type { ReviewActionResult } from "@/services/setter/review-service";
import { listAccountBundles } from "./accounts";
import { getDb, schema } from "../db";
import { getCampaignById } from "./campaigns";
import { getOfferById } from "./offers";
import { listSuppressionEntries } from "./outreach";
import { insertAuditLog } from "./audit";
import { toConversation, toDraft, toFeedback, toMessage } from "./conversations";

export interface SetterReviewItem {
  conversation: Conversation;
  message: ConversationMessage;
  draft: SetterDraft;
}

async function resolveInboundContext(event: InboundEmailReply): Promise<{
  context: SetterInboundContext;
  campaignId: string;
  accountId: string;
  contactId: string | null;
}> {
  const db = getDb();
  const campaignFilters = [
    sql`${schema.campaigns.engineConfig} ->> 'instantlyCampaignId' = ${event.providerCampaignId}`,
    sql`${schema.campaigns.engineConfig} ->> 'providerCampaignId' = ${event.providerCampaignId}`,
  ];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.providerCampaignId)) {
    campaignFilters.push(eq(schema.campaigns.id, event.providerCampaignId));
  }
  const campaignRows = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(or(...campaignFilters))
    .limit(2);
  const campaignRow = campaignRows[0];
  if (campaignRows.length !== 1 || !campaignRow) throw new Error("Instantly campaign mapping is missing or ambiguous.");

  const campaign = await getCampaignById(campaignRow.id);
  if (!campaign) throw new Error("Mapped campaign could not be loaded.");
  const offer = await getOfferById(campaign.workspaceId, campaign.offerId);
  if (!offer) throw new Error("Campaign offer could not be loaded.");

  const bundles = await listAccountBundles(campaign.workspaceId);
  const matches = bundles.flatMap((bundle) => bundle.contactPoints
    .filter((point) => point.type === "email" && point.normalizedValue === event.email)
    .map((contactPoint) => ({ bundle, contactPoint })));
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new Error("Inbound email did not resolve to exactly one workspace contact point.");

  const { bundle, contactPoint } = match;
  const [membership] = await db
    .select()
    .from(schema.campaignMemberships)
    .where(and(
      eq(schema.campaignMemberships.campaignId, campaign.id),
      eq(schema.campaignMemberships.accountId, bundle.account.id),
    ))
    .limit(1);
  if (!membership) throw new Error("Contact account is not a member of the mapped campaign.");

  const contactId = membership.contactId ?? contactPoint.contactId;
  const context: SetterInboundContext = {
    workspaceId: campaign.workspaceId,
    offer,
    account: bundle.account,
    contact: contactId ? bundle.contacts.find((item) => item.id === contactId) ?? null : null,
    discoverySource: bundle.sources[0]?.sourceType ?? null,
    recentFeedback: [],
    suppressionEntries: await listSuppressionEntries(campaign.workspaceId),
    contactPointId: contactPoint.id,
  };
  return { context, campaignId: campaign.id, accountId: bundle.account.id, contactId };
}

async function loadRecentContext(
  persisted: PersistedInboundReply,
  baseContext: SetterInboundContext,
): Promise<SetterInboundContext> {
  const db = getDb();
  const feedbackRows = await db
    .select({ feedback: schema.setterFeedback })
    .from(schema.setterFeedback)
    .innerJoin(schema.conversationMessages, eq(schema.setterFeedback.conversationMessageId, schema.conversationMessages.id))
    .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
    .where(and(
      eq(schema.conversations.workspaceId, baseContext.workspaceId),
      eq(schema.conversations.accountId, persisted.conversation.accountId),
    ))
    .orderBy(desc(schema.setterFeedback.reviewedAt))
    .limit(5);

  return {
    ...baseContext,
    recentFeedback: feedbackRows.map(({ feedback }) => toFeedback(feedback)),
  };
}

async function persistIncoming(event: InboundEmailReply, payloadHash: string): Promise<PersistedInboundReply> {
  const resolved = await resolveInboundContext(event);
  const db = getDb();
  const threadId = `instantly:${event.providerThreadId}`;
  const messageId = `instantly:${event.providerMessageId}`;
  const receivedAt = new Date(event.occurredAt);

  const persisted = await db.transaction(async (tx) => {
    const [existingMessage] = await tx
      .select({ message: schema.conversationMessages, conversation: schema.conversations })
      .from(schema.conversationMessages)
      .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
      .where(eq(schema.conversationMessages.providerMessageId, messageId))
      .limit(1);
    if (existingMessage) {
      const existingMessages = await tx
        .select()
        .from(schema.conversationMessages)
        .where(eq(schema.conversationMessages.conversationId, existingMessage.conversation.id))
        .orderBy(desc(schema.conversationMessages.createdAt))
        .limit(10);
      return {
        conversation: toConversation(existingMessage.conversation),
        message: toMessage(existingMessage.message),
        conversationMessages: existingMessages.reverse().map(toMessage),
        duplicate: true,
      };
    }

    let [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.workspaceId, resolved.context.workspaceId),
        eq(schema.conversations.providerThreadId, threadId),
      ))
      .limit(1);

    if (conversation && (conversation.accountId !== resolved.accountId || conversation.campaignId !== resolved.campaignId)) {
      throw new Error("Instantly thread is already associated with a different account or campaign.");
    }

    if (!conversation) {
      [conversation] = await tx.insert(schema.conversations).values({
        workspaceId: resolved.context.workspaceId,
        campaignId: resolved.campaignId,
        accountId: resolved.accountId,
        contactId: resolved.contactId,
        offerId: resolved.context.offer.id,
        channel: "email",
        providerThreadId: threadId,
        state: "reply_received",
        createdAt: receivedAt,
        updatedAt: receivedAt,
      }).onConflictDoNothing().returning();
      if (!conversation) {
        [conversation] = await tx
          .select()
          .from(schema.conversations)
          .where(and(
            eq(schema.conversations.workspaceId, resolved.context.workspaceId),
            eq(schema.conversations.providerThreadId, threadId),
          ))
          .limit(1);
      }
    }
    if (!conversation) throw new Error("Conversation could not be created or resolved.");

    const [message] = await tx.insert(schema.conversationMessages).values({
      conversationId: conversation.id,
      direction: "incoming",
      body: event.body,
      channel: "email",
      providerMessageId: messageId,
      metadata: {
        provider: "instantly",
        providerEventId: event.providerEventId,
        payloadHash,
        providerCampaignId: event.providerCampaignId,
        subject: event.subject,
      },
      createdAt: receivedAt,
    }).onConflictDoNothing().returning();

    if (!message) {
      const [duplicate] = await tx
        .select({ message: schema.conversationMessages, conversation: schema.conversations })
        .from(schema.conversationMessages)
        .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
        .where(eq(schema.conversationMessages.providerMessageId, messageId))
        .limit(1);
      if (!duplicate) throw new Error("Inbound message insert was skipped without a matching prior message.");
      return {
        conversation: toConversation(duplicate.conversation),
        message: toMessage(duplicate.message),
        conversationMessages: [toMessage(duplicate.message)],
        duplicate: true,
      };
    }

    await tx.update(schema.conversations)
      .set({ state: "reply_received", updatedAt: receivedAt })
      .where(eq(schema.conversations.id, conversation.id));
    const recentMessages = await tx
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversation.id))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(10);
    const persisted: PersistedInboundReply = {
      conversation: toConversation({ ...conversation, state: "reply_received", updatedAt: receivedAt }),
      message: toMessage(message),
      conversationMessages: recentMessages.reverse().map(toMessage),
    };
    return persisted;
  });
  if (!persisted.duplicate) persisted.context = await loadRecentContext(persisted, resolved.context);
  return persisted;
}

export const neonSetterInboundRuntimeStore: SetterInboundRuntimeStore = {
  async claimWebhookEvent(event, payloadHash) {
    const db = getDb();
    const [claimed] = await db.insert(schema.setterWebhookEvents).values({
      provider: "instantly",
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      payloadHash,
      metadata: { eventType: "email_replied", providerCampaignId: event.providerCampaignId },
    }).onConflictDoNothing().returning({ id: schema.setterWebhookEvents.id });
    return Boolean(claimed);
  },

  async persistIncomingReply(event, payloadHash) {
    const persisted = await persistIncoming(event, payloadHash);
    const db = getDb();
    await db.update(schema.setterWebhookEvents)
      .set({ workspaceId: persisted.conversation.workspaceId })
      .where(and(
        eq(schema.setterWebhookEvents.provider, "instantly"),
        eq(schema.setterWebhookEvents.providerEventId, event.providerEventId),
      ));
    return persisted;
  },

  async loadContext(persisted) {
    if (!persisted.context) throw new Error("Setter context was not hydrated for the incoming reply.");
    return persisted.context;
  },

  async persistResult(persisted, result: ProcessIncomingReplyResult) {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.update(schema.conversations).set({
        state: result.conversation.state,
        latestIntent: result.conversation.latestIntent,
        updatedAt: new Date(result.conversation.updatedAt),
      }).where(eq(schema.conversations.id, persisted.conversation.id));

      if (result.draft) {
        await tx.insert(schema.setterDrafts).values({
          conversationMessageId: persisted.message.id,
          language: result.draft.language,
          branch: result.draft.branch,
          intentSummary: result.draft.intentSummary,
          confidence: result.draft.confidence,
          draft: result.draft.draft,
          needsHuman: true,
          reasonForHuman: result.draft.reasonForHuman,
          detectedFactsRequested: result.draft.detectedFactsRequested,
          riskFlags: result.draft.riskFlags,
          suggestedNextAction: result.draft.suggestedNextAction,
          providerMetadata: result.draft.providerMetadata ?? {},
        }).onConflictDoNothing();
      }

      const previous = persisted.context?.suppressionEntries ?? [];
      for (const entry of result.suppressionEntries) {
        const alreadyPresent = previous.some((existing) => existing.reason === entry.reason && (
          (entry.contactPointId && existing.contactPointId === entry.contactPointId) ||
          (entry.accountId && existing.accountId === entry.accountId)
        ));
        if (alreadyPresent) continue;
        await tx.insert(schema.suppressionEntries).values({
          workspaceId: entry.workspaceId,
          contactPointId: entry.contactPointId,
          accountId: entry.accountId,
          reason: entry.reason,
        }).onConflictDoNothing();
      }
    });
  },

  async persistFailure(persisted, failureCode, reason) {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.update(schema.conversations).set({
        state: "pending_review",
        latestIntent: "HUMAN_REQUIRED",
        updatedAt: new Date(),
      }).where(eq(schema.conversations.id, persisted.conversation.id));
      await tx.insert(schema.setterDrafts).values({
        conversationMessageId: persisted.message.id,
        language: "es",
        branch: "HUMAN_REQUIRED",
        intentSummary: "Setter processing failed before a safe draft was produced.",
        confidence: 0,
        draft: "",
        needsHuman: true,
        reasonForHuman: reason,
        detectedFactsRequested: [],
        riskFlags: [failureCode],
        suggestedNextAction: "manual_human_draft",
        providerMetadata: { provider: "setter-runtime", failureCode },
      }).onConflictDoNothing();
    });
  },

  async completeWebhookEvent(event, status, workspaceId, failureCode) {
    const db = getDb();
    await db.update(schema.setterWebhookEvents).set({
      status,
      workspaceId,
      errorCode: failureCode ?? null,
      processedAt: new Date(),
    }).where(and(
      eq(schema.setterWebhookEvents.provider, "instantly"),
      eq(schema.setterWebhookEvents.providerEventId, event.providerEventId),
    ));
    if (workspaceId) {
      await insertAuditLog({
        workspaceId,
        actorUserId: null,
        action: "setter.inbound_webhook.processed",
        entityType: "setter_webhook_event",
        entityId: event.providerEventId,
        metadata: { provider: "instantly", providerMessageId: event.providerMessageId, status, failureCode: failureCode ?? null },
      });
    }
  },
};

export async function getSetterReviewItem(workspaceId: string, draftId: string): Promise<SetterReviewItem | null> {
  const db = getDb();
  const [row] = await db
    .select({ draft: schema.setterDrafts, message: schema.conversationMessages, conversation: schema.conversations })
    .from(schema.setterDrafts)
    .innerJoin(schema.conversationMessages, eq(schema.setterDrafts.conversationMessageId, schema.conversationMessages.id))
    .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
    .where(and(eq(schema.setterDrafts.id, draftId), eq(schema.conversations.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  return { draft: toDraft(row.draft), message: toMessage(row.message), conversation: toConversation(row.conversation) };
}

export async function persistSetterReviewDecision(
  workspaceId: string,
  item: SetterReviewItem,
  result: ReviewActionResult,
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(schema.conversations).set({
      state: result.conversation.state,
      latestIntent: result.conversation.latestIntent,
      updatedAt: new Date(result.conversation.updatedAt),
    }).where(and(
      eq(schema.conversations.id, item.conversation.id),
      eq(schema.conversations.workspaceId, workspaceId),
      eq(schema.conversations.state, "pending_review"),
    )).returning({ id: schema.conversations.id });
    if (!updated) return false;

    const [feedback] = await tx.insert(schema.setterFeedback).values({
      conversationMessageId: result.feedback.conversationMessageId,
      predictedBranch: result.feedback.predictedBranch,
      correctedBranch: result.feedback.correctedBranch,
      aiDraft: result.feedback.aiDraft,
      correctedText: result.feedback.correctedText,
      finalText: result.feedback.finalText ?? null,
      decision: result.feedback.decision,
      reasonCategory: result.feedback.reasonCategory,
      note: result.feedback.note,
      meetingOutcome: result.feedback.meetingOutcome,
      qualified: result.feedback.qualified,
      lostReason: result.feedback.lostReason,
      reviewedAt: new Date(result.feedback.reviewedAt),
      reviewerId: result.feedback.reviewerId,
    }).onConflictDoNothing().returning({ id: schema.setterFeedback.id });
    if (!feedback) throw new Error("Setter feedback already exists for this reply.");
    return true;
  });
}