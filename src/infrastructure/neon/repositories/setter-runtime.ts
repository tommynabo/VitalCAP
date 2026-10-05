import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { InboundEmailReply } from "@/domain/providers/types";
import type { Conversation, ConversationMessage, SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import type { ProcessIncomingReplyResult } from "@/services/setter/setter-orchestrator";
import type { PersistedInboundReply, SetterInboundContext, SetterInboundRuntimeStore } from "@/services/setter/inbound-runtime";
import { SetterInboundRoutingError } from "@/services/setter/inbound-runtime";
import type { ReviewActionResult } from "@/services/setter/review-service";
import { InstantlyReplyApiError, InstantlyReplyProvider } from "@/infrastructure/providers/instantly/reply-provider";
import { getDeliveryEnv } from "@/lib/config/env";
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

export interface SetterWebhookEventSummary {
  id: string;
  status: string;
  duplicateAttempts: number;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
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
  const campaignRows = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(or(...campaignFilters))
    .limit(2);
  const campaignRow = campaignRows[0];
  if (campaignRows.length === 0) throw new SetterInboundRoutingError("UNKNOWN_CAMPAIGN");
  if (campaignRows.length > 1 || !campaignRow) throw new SetterInboundRoutingError("AMBIGUOUS_CAMPAIGN");

  const campaign = await getCampaignById(campaignRow.id);
  if (!campaign) throw new Error("Mapped campaign could not be loaded.");
  const offer = await getOfferById(campaign.workspaceId, campaign.offerId);
  if (!offer) throw new Error("Campaign offer could not be loaded.");

  const bundles = await listAccountBundles(campaign.workspaceId);
  const matches = bundles.flatMap((bundle) => bundle.contactPoints
    .filter((point) => point.type === "email" && point.normalizedValue === event.email)
    .map((contactPoint) => ({ bundle, contactPoint })));
  const match = matches[0];
  if (matches.length === 0) throw new SetterInboundRoutingError("CONTACT_NOT_FOUND", campaign.workspaceId);
  if (matches.length > 1 || !match) throw new SetterInboundRoutingError("AMBIGUOUS_CONTACT_MATCH", campaign.workspaceId);

  const { bundle, contactPoint } = match;
  const [membership] = await db
    .select()
    .from(schema.campaignMemberships)
    .where(and(
      eq(schema.campaignMemberships.campaignId, campaign.id),
      eq(schema.campaignMemberships.accountId, bundle.account.id),
    ))
    .limit(1);
  if (!membership) throw new SetterInboundRoutingError("CONTACT_NOT_FOUND", campaign.workspaceId);

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
        eventType: event.eventType ?? "email_replied",
        providerEventId: event.providerEventId,
        providerMessageId: event.providerMessageId,
        providerThreadId: event.providerThreadId,
        leadEmail: event.email,
        payloadHash,
        providerCampaignId: event.providerCampaignId,
        campaignName: event.campaignName ?? null,
        workspace: event.workspace ?? null,
        emailAccount: event.emailAccount ?? null,
        replyToUuid: event.providerMessageId,
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
      metadata: {
        eventType: event.eventType ?? "email_replied",
        providerCampaignId: event.providerCampaignId,
        providerMessageId: event.providerMessageId,
      },
    }).onConflictDoNothing().returning({ id: schema.setterWebhookEvents.id });
    if (claimed) return true;

    await db.update(schema.setterWebhookEvents).set({
      metadata: sql`jsonb_set(
        ${schema.setterWebhookEvents.metadata},
        '{duplicateAttempts}',
        to_jsonb(coalesce((${schema.setterWebhookEvents.metadata}->>'duplicateAttempts')::int, 0) + 1),
        true
      )`,
    }).where(and(
      eq(schema.setterWebhookEvents.provider, "instantly"),
      eq(schema.setterWebhookEvents.providerEventId, event.providerEventId),
    ));
    return false;
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

export async function listSetterWebhookEvents(workspaceId: string): Promise<SetterWebhookEventSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.setterWebhookEvents.id,
      status: schema.setterWebhookEvents.status,
      duplicateAttempts: sql<number>`coalesce((${schema.setterWebhookEvents.metadata}->>'duplicateAttempts')::int, 0)`,
      errorCode: schema.setterWebhookEvents.errorCode,
      receivedAt: schema.setterWebhookEvents.receivedAt,
      processedAt: schema.setterWebhookEvents.processedAt,
    })
    .from(schema.setterWebhookEvents)
    .where(eq(schema.setterWebhookEvents.workspaceId, workspaceId))
    .orderBy(desc(schema.setterWebhookEvents.receivedAt));
  return rows.map((row) => ({
    ...row,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  }));
}

export async function processInstantlyComplianceEvent(input: {
  providerEventId: string;
  providerMessageId: string;
  providerCampaignId: string;
  email: string;
  code: "bounced" | "unsubscribed";
  occurredAt: string;
  payloadHash: string;
}): Promise<{ outcome: "processed" | "duplicate_skipped" | "ignored_unknown_campaign" | "human_required"; errorCode?: string }> {
  const db = getDb();
  const [claimed] = await db.insert(schema.setterWebhookEvents).values({
    provider: "instantly",
    providerEventId: input.providerEventId,
    providerMessageId: input.providerMessageId,
    payloadHash: input.payloadHash,
    metadata: {
      eventType: input.code === "unsubscribed" ? "lead_unsubscribed" : "email_bounced",
      providerCampaignId: input.providerCampaignId,
    },
  }).onConflictDoNothing().returning({ id: schema.setterWebhookEvents.id });
  if (!claimed) {
    await db.update(schema.setterWebhookEvents).set({
      metadata: sql`jsonb_set(
        ${schema.setterWebhookEvents.metadata},
        '{duplicateAttempts}',
        to_jsonb(coalesce((${schema.setterWebhookEvents.metadata}->>'duplicateAttempts')::int, 0) + 1),
        true
      )`,
    }).where(and(
      eq(schema.setterWebhookEvents.provider, "instantly"),
      eq(schema.setterWebhookEvents.providerEventId, input.providerEventId),
    ));
    return { outcome: "duplicate_skipped" };
  }

  const campaignRows = await db.select({ id: schema.campaigns.id, workspaceId: schema.campaigns.workspaceId })
    .from(schema.campaigns)
    .where(or(
      sql`${schema.campaigns.engineConfig} ->> 'instantlyCampaignId' = ${input.providerCampaignId}`,
      sql`${schema.campaigns.engineConfig} ->> 'providerCampaignId' = ${input.providerCampaignId}`,
    ))
    .limit(2);
  if (campaignRows.length === 0) {
    await completeComplianceWebhookEvent(input.providerEventId, "ignored", null, "UNKNOWN_CAMPAIGN");
    return { outcome: "ignored_unknown_campaign" };
  }
  if (campaignRows.length > 1) {
    await completeComplianceWebhookEvent(input.providerEventId, "human_required", null, "AMBIGUOUS_CAMPAIGN");
    return { outcome: "human_required", errorCode: "AMBIGUOUS_CAMPAIGN" };
  }

  const workspaceId = campaignRows[0]!.workspaceId;
  const contactPointRows = await db.select({ id: schema.contactPoints.id, accountId: schema.contactPoints.accountId })
    .from(schema.contactPoints)
    .where(and(
      eq(schema.contactPoints.workspaceId, workspaceId),
      eq(schema.contactPoints.type, "email"),
      eq(schema.contactPoints.normalizedValue, input.email),
    ))
    .limit(2);
  if (contactPointRows.length !== 1) {
    const code = contactPointRows.length === 0 ? "CONTACT_NOT_FOUND" : "AMBIGUOUS_CONTACT_MATCH";
    await completeComplianceWebhookEvent(input.providerEventId, "human_required", workspaceId, code);
    return { outcome: "human_required", errorCode: code };
  }

  const contactPoint = contactPointRows[0]!;
  const now = new Date(input.occurredAt);
  const reason = input.code === "unsubscribed" ? "provider_unsubscribe" : "permanent_bounce";
  await db.transaction(async (tx) => {
    const [existingSuppression] = await tx.select({ id: schema.suppressionEntries.id })
      .from(schema.suppressionEntries)
      .where(and(
        eq(schema.suppressionEntries.workspaceId, workspaceId),
        eq(schema.suppressionEntries.contactPointId, contactPoint.id),
        eq(schema.suppressionEntries.reason, reason),
      ))
      .limit(1);
    if (!existingSuppression) {
      await tx.insert(schema.suppressionEntries).values({
        workspaceId,
        contactPointId: contactPoint.id,
        accountId: null,
        reason,
        createdAt: now,
      });
    }

    await tx.update(schema.contactPoints).set(input.code === "unsubscribed"
      ? { channelEligibility: "opted_out", status: "ineligible", updatedAt: now }
      : { channelEligibility: "blocked", status: "ineligible", verificationStatus: "bounced", updatedAt: now })
      .where(eq(schema.contactPoints.id, contactPoint.id));

    const [contact] = await tx.select({ contactId: schema.contactPoints.contactId })
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.id, contactPoint.id))
      .limit(1);
    const matchingConversations = contact?.contactId
      ? await tx.select({ id: schema.conversations.id }).from(schema.conversations).where(and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.contactId, contact.contactId),
        ))
      : [];
    if (matchingConversations.length > 0) {
      await tx.update(schema.warmFollowupQueue).set({ status: "paused", pauseReason: reason, updatedAt: now })
        .where(and(
          inArray(schema.warmFollowupQueue.conversationId, matchingConversations.map(({ id }) => id)),
          eq(schema.warmFollowupQueue.status, "active"),
        ));
    }
    await tx.update(schema.outreachQueue).set({
      status: "canceled",
      state: "canceled",
      nextAttemptAt: null,
      updatedAt: now,
    }).where(and(
      eq(schema.outreachQueue.workspaceId, workspaceId),
      eq(schema.outreachQueue.contactPointId, contactPoint.id),
      eq(schema.outreachQueue.status, "pending"),
      inArray(schema.outreachQueue.state, ["queued", "scheduled"]),
    ));
    await tx.update(schema.setterWebhookEvents).set({ workspaceId, status: "processed", processedAt: now })
      .where(and(
        eq(schema.setterWebhookEvents.provider, "instantly"),
        eq(schema.setterWebhookEvents.providerEventId, input.providerEventId),
      ));
  });
  return { outcome: "processed" };
}

export async function processInstantlySentEvent(input: {
  providerEventId: string;
  providerMessageId: string;
  providerCampaignId: string;
  email: string;
  occurredAt: string;
  payloadHash: string;
}): Promise<{ outcome: "processed" | "duplicate_skipped" | "ignored_unknown_campaign" | "human_required"; errorCode?: string }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [claimed] = await tx.insert(schema.setterWebhookEvents).values({
      provider: "instantly",
      providerEventId: input.providerEventId,
      providerMessageId: input.providerMessageId,
      payloadHash: input.payloadHash,
      metadata: { eventType: "email_sent", providerCampaignId: input.providerCampaignId },
    }).onConflictDoNothing().returning({ id: schema.setterWebhookEvents.id });
    if (!claimed) {
      await tx.update(schema.setterWebhookEvents).set({
        metadata: sql`jsonb_set(
          ${schema.setterWebhookEvents.metadata},
          '{duplicateAttempts}',
          to_jsonb(coalesce((${schema.setterWebhookEvents.metadata}->>'duplicateAttempts')::int, 0) + 1),
          true
        )`,
      }).where(and(
        eq(schema.setterWebhookEvents.provider, "instantly"),
        eq(schema.setterWebhookEvents.providerEventId, input.providerEventId),
      ));
      return { outcome: "duplicate_skipped" };
    }

    const campaignRows = await tx.select({ id: schema.campaigns.id, workspaceId: schema.campaigns.workspaceId })
      .from(schema.campaigns)
      .where(or(
        sql`${schema.campaigns.engineConfig} ->> 'instantlyCampaignId' = ${input.providerCampaignId}`,
        sql`${schema.campaigns.engineConfig} ->> 'providerCampaignId' = ${input.providerCampaignId}`,
      ))
      .limit(2);
    if (campaignRows.length !== 1) {
      const errorCode = campaignRows.length === 0 ? "UNKNOWN_CAMPAIGN" : "AMBIGUOUS_CAMPAIGN";
      await tx.update(schema.setterWebhookEvents).set({
        status: campaignRows.length === 0 ? "ignored" : "human_required",
        errorCode,
        processedAt: new Date(input.occurredAt),
      }).where(eq(schema.setterWebhookEvents.id, claimed.id));
      return campaignRows.length === 0
        ? { outcome: "ignored_unknown_campaign" as const }
        : { outcome: "human_required" as const, errorCode };
    }

    const campaign = campaignRows[0]!;
    const contactPointRows = await tx.select({
      id: schema.contactPoints.id,
      accountId: schema.contactPoints.accountId,
      contactId: schema.contactPoints.contactId,
    }).from(schema.contactPoints).where(and(
      eq(schema.contactPoints.workspaceId, campaign.workspaceId),
      eq(schema.contactPoints.type, "email"),
      eq(schema.contactPoints.normalizedValue, input.email.trim().toLowerCase()),
    )).limit(2);
    if (contactPointRows.length !== 1) {
      const errorCode = contactPointRows.length === 0 ? "CONTACT_NOT_FOUND" : "AMBIGUOUS_CONTACT_MATCH";
      await tx.update(schema.setterWebhookEvents).set({
        workspaceId: campaign.workspaceId,
        status: "human_required",
        errorCode,
        processedAt: new Date(input.occurredAt),
      }).where(eq(schema.setterWebhookEvents.id, claimed.id));
      return { outcome: "human_required" as const, errorCode };
    }

    const contactPoint = contactPointRows[0]!;
    const occurredAt = new Date(input.occurredAt);
    const [queueItem] = await tx.insert(schema.outreachQueue).values({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      accountId: contactPoint.accountId,
      contactId: contactPoint.contactId,
      contactPointId: contactPoint.id,
      normalizedEmail: input.email.trim().toLowerCase(),
      channel: "email",
      status: "completed",
      state: "sent",
      deliveryMode: "live",
      scheduledFor: occurredAt,
      nextAttemptAt: null,
      payload: { provider: "instantly", providerLeadId: input.providerMessageId },
    }).returning({ id: schema.outreachQueue.id });

    await tx.insert(schema.outreachEvents).values({
      outreachQueueItemId: queueItem!.id,
      state: "sent",
      providerEventId: input.providerEventId,
      payloadHash: input.payloadHash,
      occurredAt,
    });
    await tx.update(schema.campaignMemberships).set({
      contactedAt: sql`greatest(coalesce(${schema.campaignMemberships.contactedAt}, '-infinity'::timestamptz), ${occurredAt})`,
      updatedAt: new Date(),
    })
      .where(and(
        eq(schema.campaignMemberships.campaignId, campaign.id),
        eq(schema.campaignMemberships.accountId, contactPoint.accountId),
      ));
    await tx.update(schema.contactPoints).set({
      lastContactedAt: sql`greatest(coalesce(${schema.contactPoints.lastContactedAt}, '-infinity'::timestamptz), ${occurredAt})`,
      updatedAt: new Date(),
    }).where(eq(schema.contactPoints.id, contactPoint.id));
    await tx.update(schema.setterWebhookEvents).set({
      workspaceId: campaign.workspaceId,
      status: "processed",
      processedAt: occurredAt,
    }).where(eq(schema.setterWebhookEvents.id, claimed.id));
    return { outcome: "processed" as const };
  });
}

export async function recordInstantlyIgnoredEvent(input: {
  eventType: string;
  providerEventId: string;
  providerMessageId: string;
  providerCampaignId: string | null;
  payloadHash: string;
}): Promise<void> {
  const db = getDb();
  let workspaceId: string | null = null;
  if (input.providerCampaignId) {
    const campaignRows = await db.select({ workspaceId: schema.campaigns.workspaceId })
      .from(schema.campaigns)
      .where(or(
        sql`${schema.campaigns.engineConfig} ->> 'instantlyCampaignId' = ${input.providerCampaignId}`,
        sql`${schema.campaigns.engineConfig} ->> 'providerCampaignId' = ${input.providerCampaignId}`,
      ))
      .limit(2);
    if (campaignRows.length === 1) workspaceId = campaignRows[0]!.workspaceId;
  }

  await db.insert(schema.setterWebhookEvents).values({
    workspaceId,
    provider: "instantly",
    providerEventId: input.providerEventId,
    providerMessageId: input.providerMessageId,
    payloadHash: input.payloadHash,
    status: "ignored",
    errorCode: null,
    metadata: {
      eventType: input.eventType,
      providerCampaignId: input.providerCampaignId,
    },
    processedAt: new Date(),
  }).onConflictDoNothing();
}

async function completeComplianceWebhookEvent(
  providerEventId: string,
  status: string,
  workspaceId: string | null,
  errorCode: string,
): Promise<void> {
  const db = getDb();
  await db.update(schema.setterWebhookEvents).set({ status, workspaceId, errorCode, processedAt: new Date() })
    .where(and(
      eq(schema.setterWebhookEvents.provider, "instantly"),
      eq(schema.setterWebhookEvents.providerEventId, providerEventId),
    ));
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

export type SetterReplyDeliveryResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; errorCode: string }
  | { status: "uncertain"; errorCode: string }
  | { status: "reconciliation_required"; errorCode: "SEND_UNKNOWN_REQUIRES_RECONCILIATION" }
  | { status: "already_claimed" };

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerReplyErrorCode(error: unknown): { errorCode: string; uncertain: boolean } {
  if (!(error instanceof InstantlyReplyApiError)) return { errorCode: "INSTANTLY_REPLY_NETWORK_UNCERTAIN", uncertain: true };
  if (error.httpStatus === 401) return { errorCode: "INSTANTLY_REPLY_401", uncertain: false };
  if (error.httpStatus === 403) return { errorCode: "INSTANTLY_REPLY_403", uncertain: false };
  if (error.httpStatus === 429) return { errorCode: "INSTANTLY_REPLY_429", uncertain: false };
  if (error.httpStatus === 408 || error.httpStatus >= 500) return { errorCode: "INSTANTLY_REPLY_RESULT_UNCERTAIN", uncertain: true };
  return { errorCode: "INSTANTLY_REPLY_REJECTED", uncertain: false };
}

export async function sendReviewedSetterReply(workspaceId: string, draftId: string): Promise<SetterReplyDeliveryResult> {
  const env = getDeliveryEnv();
  if (env.EMAIL_DELIVERY_PROVIDER !== "instantly" || !env.INSTANTLY_API_KEY) {
    return { status: "failed", errorCode: "INSTANTLY_REPLY_CONFIGURATION_ERROR" };
  }

  const db = getDb();
  const claim = await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ draft: schema.setterDrafts, message: schema.conversationMessages, conversation: schema.conversations, feedback: schema.setterFeedback })
      .from(schema.setterDrafts)
      .innerJoin(schema.conversationMessages, eq(schema.setterDrafts.conversationMessageId, schema.conversationMessages.id))
      .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
      .innerJoin(schema.setterFeedback, eq(schema.setterFeedback.conversationMessageId, schema.conversationMessages.id))
      .where(and(eq(schema.setterDrafts.id, draftId), eq(schema.conversations.workspaceId, workspaceId)))
      .limit(1);
    if (!item || item.conversation.state !== "approved_pending_send" || !item.feedback.finalText?.trim()) return null;
    const previousDelivery = jsonObject(item.message.metadata).replyDelivery;
    if (jsonObject(previousDelivery).status === "send_unknown") {
      await tx.update(schema.conversations).set({ state: "send_unknown", updatedAt: new Date() })
        .where(eq(schema.conversations.id, item.conversation.id));
      return { reconciliationRequired: true as const };
    }

    const now = new Date();
    const [claimed] = await tx.update(schema.conversations).set({ state: "sending", updatedAt: now })
      .where(and(
        eq(schema.conversations.id, item.conversation.id),
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.state, "approved_pending_send"),
      ))
      .returning({ id: schema.conversations.id });
    if (!claimed) return null;

    const metadata = jsonObject(item.message.metadata);
    await tx.update(schema.conversationMessages).set({
      metadata: {
        ...metadata,
        replyDelivery: {
          status: "sending",
          attemptedAt: now.toISOString(),
          setterDraftId: item.draft.id,
          reviewDecision: item.feedback.decision,
        },
      },
    }).where(eq(schema.conversationMessages.id, item.message.id));

    return { ...item, messageMetadata: metadata };
  });
  if (!claim) return { status: "already_claimed" };
  if ("reconciliationRequired" in claim) {
    return { status: "reconciliation_required", errorCode: "SEND_UNKNOWN_REQUIRES_RECONCILIATION" };
  }

  const provider = new InstantlyReplyProvider(env.INSTANTLY_API_KEY);
  const replyToUuid = typeof claim.messageMetadata.replyToUuid === "string"
    ? claim.messageMetadata.replyToUuid
    : claim.message.providerMessageId?.replace(/^instantly:/, "") ?? null;
  if (!replyToUuid) {
    await recordReplySendFailure(db, claim.conversation.id, claim.message, "send_failed", "CANNOT_RESOLVE_REPLY_UUID");
    return { status: "failed", errorCode: "CANNOT_RESOLVE_REPLY_UUID" };
  }

  let emailAccount = typeof claim.messageMetadata.emailAccount === "string"
    ? claim.messageMetadata.emailAccount
    : typeof claim.messageMetadata.eaccount === "string" ? claim.messageMetadata.eaccount : null;
  if (!emailAccount) {
    try {
      emailAccount = await provider.resolveEmailAccount(replyToUuid);
    } catch {
      emailAccount = null;
    }
    if (emailAccount) {
      const metadata = jsonObject(claim.message.metadata);
      await db.update(schema.conversationMessages).set({ metadata: { ...metadata, emailAccount, replyToUuid } })
        .where(eq(schema.conversationMessages.id, claim.message.id));
    }
  }
  if (!emailAccount) {
    await recordReplySendFailure(db, claim.conversation.id, claim.message, "send_failed", "CANNOT_RESOLVE_SENDING_ACCOUNT");
    return { status: "failed", errorCode: "CANNOT_RESOLVE_SENDING_ACCOUNT" };
  }

  const feedback = claim.feedback;
  let providerResponse;
  try {
    providerResponse = await provider.reply({
      eaccount: emailAccount,
      replyToUuid,
      subject: typeof claim.messageMetadata.subject === "string" ? claim.messageMetadata.subject : "",
      text: feedback.finalText!,
    });
  } catch (error) {
    const failure = providerReplyErrorCode(error);
    await recordReplySendFailure(
      db,
      claim.conversation.id,
      claim.message,
      failure.uncertain ? "send_unknown" : "send_failed",
      failure.errorCode,
    );
    return { status: failure.uncertain ? "uncertain" : "failed", errorCode: failure.errorCode };
  }

  const acceptedAt = new Date();
  const acceptedMetadata = {
    ...jsonObject(claim.message.metadata),
    emailAccount,
    replyToUuid,
    replyDelivery: {
      status: "provider_accepted",
      acceptedAt: acceptedAt.toISOString(),
      providerMessageId: providerResponse.providerMessageId,
      providerResponseIdentifiers: providerResponse.responseIdentifiers,
      setterDraftId: claim.draft.id,
      reviewDecision: feedback.decision,
    },
  };
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.conversations).set({ state: "send_accepted", updatedAt: acceptedAt })
        .where(and(eq(schema.conversations.id, claim.conversation.id), eq(schema.conversations.state, "sending")));
      await tx.update(schema.conversationMessages).set({ metadata: acceptedMetadata })
        .where(eq(schema.conversationMessages.id, claim.message.id));
    });
  } catch {
    await recordReplySendFailure(db, claim.conversation.id, claim.message, "send_unknown", "PROVIDER_ACCEPTED_PERSISTENCE_UNCERTAIN", {
      providerMessageId: providerResponse.providerMessageId,
      providerResponseIdentifiers: providerResponse.responseIdentifiers,
      eaccount: emailAccount,
      replyToUuid,
    });
    return { status: "uncertain", errorCode: "PROVIDER_ACCEPTED_PERSISTENCE_UNCERTAIN" };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.conversationMessages).values({
        conversationId: claim.conversation.id,
        direction: "outgoing",
        body: feedback.finalText!,
        channel: "email",
        providerMessageId: providerResponse.providerMessageId ? `instantly:${providerResponse.providerMessageId}` : null,
        metadata: {
          provider: "instantly",
          replyToUuid,
          eaccount: emailAccount,
          reviewDecision: feedback.decision,
          setterDraftId: claim.draft.id,
          providerResponseIdentifiers: providerResponse.responseIdentifiers,
        },
        createdAt: acceptedAt,
      }).onConflictDoNothing();
      await tx.update(schema.conversations).set({ state: "sent", updatedAt: acceptedAt })
        .where(and(eq(schema.conversations.id, claim.conversation.id), eq(schema.conversations.state, "send_accepted")));
    });
  } catch {
    await recordReplySendFailure(db, claim.conversation.id, claim.message, "send_unknown", "PROVIDER_ACCEPTED_FINALIZATION_UNCERTAIN", {
      providerMessageId: providerResponse.providerMessageId,
      providerResponseIdentifiers: providerResponse.responseIdentifiers,
      eaccount: emailAccount,
      replyToUuid,
    });
    return { status: "uncertain", errorCode: "PROVIDER_ACCEPTED_FINALIZATION_UNCERTAIN" };
  }

  return { status: "sent", providerMessageId: providerResponse.providerMessageId };
}

async function recordReplySendFailure(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  message: { id: string; metadata: unknown },
  state: "send_failed" | "send_unknown",
  errorCode: string,
  deliveryDetails: Record<string, unknown> = {},
): Promise<void> {
  const metadata = jsonObject(message.metadata);
  await db.transaction(async (tx) => {
    await tx.update(schema.conversations).set({ state, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));
    await tx.update(schema.conversationMessages).set({
      metadata: { ...metadata, replyDelivery: { ...deliveryDetails, status: state, errorCode, failedAt: new Date().toISOString() } },
    }).where(eq(schema.conversationMessages.id, message.id));
  });
}