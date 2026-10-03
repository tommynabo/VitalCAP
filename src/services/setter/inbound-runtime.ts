import type { Conversation, ConversationMessage, SetterFeedback } from "@/domain/conversations/types";
import type { Account } from "@/domain/accounts/types";
import type { Contact } from "@/domain/contacts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { InboundEmailReply, LLMProvider } from "@/domain/providers/types";
import type { SuppressionEntry } from "@/domain/outreach/types";
import { createSetterLLMProvider } from "@/infrastructure/providers/llm/factory";
import { processIncomingReply, type ProcessIncomingReplyResult } from "./setter-orchestrator";

export interface PersistedInboundReply {
  conversation: Conversation;
  message: ConversationMessage;
  conversationMessages: ConversationMessage[];
  duplicate?: boolean;
  context?: SetterInboundContext;
}

export interface SetterInboundContext {
  workspaceId: string;
  offer: Offer;
  account: Account;
  contact: Contact | null;
  discoverySource: string | null;
  recentFeedback: SetterFeedback[];
  suppressionEntries: SuppressionEntry[];
  contactPointId: string | null;
}

export interface SetterInboundRuntimeStore {
  claimWebhookEvent(event: InboundEmailReply, payloadHash: string): Promise<boolean>;
  persistIncomingReply(event: InboundEmailReply, payloadHash: string): Promise<PersistedInboundReply>;
  loadContext(persisted: PersistedInboundReply): Promise<SetterInboundContext>;
  persistResult(persisted: PersistedInboundReply, result: ProcessIncomingReplyResult): Promise<void>;
  persistFailure(persisted: PersistedInboundReply, failureCode: string, reason: string): Promise<void>;
  completeWebhookEvent(event: InboundEmailReply, status: string, workspaceId: string | null, failureCode?: string): Promise<void>;
}

export type SetterInboundRuntimeResult =
  | { outcome: "duplicate_skipped" }
  | { outcome: "processed"; result: ProcessIncomingReplyResult }
  | { outcome: "human_required"; failureCode: string };

function lazyProvider(factory: () => LLMProvider): LLMProvider {
  let resolvedProvider: LLMProvider | null = null;
  return {
    get providerName() {
      return resolvedProvider?.providerName ?? "configured-setter-llm";
    },
    async classifyAndDraft(context) {
      resolvedProvider ??= factory();
      return resolvedProvider.classifyAndDraft(context);
    },
  };
}

function safeFailureCode(error: unknown): string {
  const details = error as { name?: string; code?: string; status?: number; message?: string };
  if (details.status === 429 || details.code === "rate_limit_exceeded") return "rate_limit";
  if (details.name === "AbortError" || details.name === "TimeoutError" || details.code === "ETIMEDOUT") return "timeout";
  if (/configuration|api key/i.test(details.message ?? "")) return "configuration_error";
  return "processing_failure";
}

export async function processInstantlyInboundReply(
  event: InboundEmailReply,
  payloadHash: string,
  store: SetterInboundRuntimeStore,
  now = new Date(),
  providerFactory: () => LLMProvider = createSetterLLMProvider,
): Promise<SetterInboundRuntimeResult> {
  if (!(await store.claimWebhookEvent(event, payloadHash))) return { outcome: "duplicate_skipped" };

  let persisted: PersistedInboundReply | null = null;
  let workspaceId: string | null = null;
  try {
    persisted = await store.persistIncomingReply(event, payloadHash);
    if (persisted.duplicate) {
      await store.completeWebhookEvent(event, "duplicate_skipped", persisted.conversation.workspaceId);
      return { outcome: "duplicate_skipped" };
    }
    const context = await store.loadContext(persisted);
    workspaceId = context.workspaceId;

    const result = await processIncomingReply({
      ...context,
      conversation: persisted.conversation,
      incomingMessage: persisted.message,
      conversationMessages: persisted.conversationMessages,
      llmProvider: lazyProvider(providerFactory),
      now,
    });

    await store.persistResult(persisted, result);
    const eventStatus = result.draft ? "pending_review" : result.conversation.state;
    await store.completeWebhookEvent(event, eventStatus, workspaceId);
    return { outcome: "processed", result };
  } catch (error) {
    const failureCode = safeFailureCode(error);
    if (persisted) {
      await store.persistFailure(persisted, failureCode, "Setter processing failed; human review is required.");
      await store.completeWebhookEvent(event, "human_required", workspaceId, failureCode);
      return { outcome: "human_required", failureCode };
    }
    await store.completeWebhookEvent(event, "failed", workspaceId, failureCode);
    throw error;
  }
}