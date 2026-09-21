import { verifyWebhookSignature } from "@/services/outreach/outreach-event-ingestion";
import type { Conversation, ConversationMessage } from "@/domain/conversations/types";
import type { ContactPointType } from "@/domain/contacts/types";

/**
 * Reply ingestion (Prompt 4 §4.1). Normalizes an inbound email or SMS
 * webhook payload into a `ConversationMessage` (creating the `Conversation`
 * if one does not already exist for the provider thread). Dedup key is
 * `providerMessageId` — reusing Phase 3's `verifyWebhookSignature` HMAC
 * check and the same "processing the same provider event twice never
 * duplicates state" guarantee (`docs/REFERENCE_AUDIT.md` lesson).
 */
export { verifyWebhookSignature };

export interface IncomingReplyPayload {
  workspaceId: string;
  accountId: string;
  contactId: string | null;
  campaignId: string;
  offerId: string;
  channel: ContactPointType;
  providerThreadId: string;
  providerMessageId: string;
  body: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export type ReplyIngestOutcome = "conversation_created" | "conversation_reused" | "duplicate_skipped";

export interface ReplyIngestResult {
  conversations: Conversation[];
  messages: ConversationMessage[];
  outcome: ReplyIngestOutcome;
  conversation: Conversation;
  message: ConversationMessage;
}

export function ingestIncomingReply(
  existingConversations: readonly Conversation[],
  existingMessages: readonly ConversationMessage[],
  input: IncomingReplyPayload,
  generateId: () => string,
): ReplyIngestResult {
  const duplicate = existingMessages.find((message) => message.providerMessageId === input.providerMessageId);
  if (duplicate) {
    const owner = existingConversations.find((conversation) => conversation.id === duplicate.conversationId);
    if (!owner) {
      throw new Error(`Duplicate message ${duplicate.id} references missing conversation ${duplicate.conversationId}`);
    }
    return {
      conversations: [...existingConversations],
      messages: [...existingMessages],
      outcome: "duplicate_skipped",
      conversation: owner,
      message: duplicate,
    };
  }

  const existingConversation = existingConversations.find((conversation) => conversation.providerThreadId === input.providerThreadId);
  const now = input.occurredAt;

  const conversation: Conversation = existingConversation
    ? { ...existingConversation, state: "reply_received", updatedAt: now }
    : {
        id: generateId(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        contactId: input.contactId,
        campaignId: input.campaignId,
        offerId: input.offerId,
        channel: input.channel,
        providerThreadId: input.providerThreadId,
        state: "reply_received",
        latestIntent: null,
        createdAt: now,
        updatedAt: now,
      };

  const message: ConversationMessage = {
    id: generateId(),
    conversationId: conversation.id,
    direction: "incoming",
    body: input.body,
    channel: input.channel,
    providerMessageId: input.providerMessageId,
    metadata: input.metadata ?? {},
    createdAt: now,
  };

  const conversations = existingConversation
    ? existingConversations.map((existing) => (existing.id === conversation.id ? conversation : existing))
    : [...existingConversations, conversation];

  return {
    conversations,
    messages: [...existingMessages, message],
    outcome: existingConversation ? "conversation_reused" : "conversation_created",
    conversation,
    message,
  };
}
