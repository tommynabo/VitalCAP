import type { Account } from "@/domain/accounts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { Contact } from "@/domain/contacts/types";
import type { Conversation, ConversationMessage, SetterFeedback } from "@/domain/conversations/types";
import type { SuppressionEntry } from "@/domain/outreach/types";
import type { LLMProvider } from "@/domain/providers/types";
import { addSuppression, checkSuppression } from "@/services/compliance/suppression-service";
import { buildSetterContext } from "./context-builder";
import { classifyAndDraft, type DraftFields } from "./classify-and-draft";
import { detectDeterministicCase, type PreRouterResult } from "./pre-router";

/**
 * Setter orchestrator (Prompt 4 — ties together §4.1–§4.6). Composes the
 * deterministic pre-router, existing suppression checks, the context
 * builder and the classify-and-draft pipeline for a single incoming reply.
 * Per §4.2, an unsubscribe/do-not-contact match is applied unconditionally
 * *before* any LLM call is even considered — the LLM is never given a
 * chance to override it.
 */
export interface ProcessIncomingReplyInput {
  workspaceId: string;
  conversation: Conversation;
  incomingMessage: ConversationMessage;
  conversationMessages: readonly ConversationMessage[];
  offer: Offer;
  account: Account;
  contact: Contact | null;
  discoverySource: string | null;
  recentFeedback: readonly SetterFeedback[];
  suppressionEntries: readonly SuppressionEntry[];
  contactPointId: string | null;
  llmProvider: LLMProvider;
  now: Date;
}

export interface ProcessIncomingReplyResult {
  conversation: Conversation;
  draft: DraftFields | null;
  suppressionEntries: SuppressionEntry[];
  preRouterResult: PreRouterResult;
  usedLLM: boolean;
}

export async function processIncomingReply(input: ProcessIncomingReplyInput): Promise<ProcessIncomingReplyResult> {
  const nowIso = input.now.toISOString();
  const preRouterResult = detectDeterministicCase(input.incomingMessage.body);

  if (preRouterResult.matched && preRouterResult.suppress) {
    const suppressionEntries = addSuppression([...input.suppressionEntries], {
      workspaceId: input.workspaceId,
      contactPointId: input.contactPointId,
      accountId: input.account.id,
      reason: "unsubscribe",
      now: input.now,
    });
    return {
      conversation: { ...input.conversation, state: "suppressed", latestIntent: preRouterResult.branch, updatedAt: nowIso },
      draft: null,
      suppressionEntries,
      preRouterResult,
      usedLLM: false,
    };
  }

  if (preRouterResult.matched) {
    return {
      conversation: { ...input.conversation, state: "pre_routed", latestIntent: preRouterResult.branch, updatedAt: nowIso },
      draft: null,
      suppressionEntries: [...input.suppressionEntries],
      preRouterResult,
      usedLLM: false,
    };
  }

  const suppressionCheck = checkSuppression({ contactPointId: input.contactPointId, accountId: input.account.id }, input.suppressionEntries);
  if (suppressionCheck.suppressed) {
    return {
      conversation: { ...input.conversation, state: "suppressed", updatedAt: nowIso },
      draft: null,
      suppressionEntries: [...input.suppressionEntries],
      preRouterResult,
      usedLLM: false,
    };
  }

  const context = buildSetterContext({
    offer: input.offer,
    account: input.account,
    contact: input.contact,
    discoverySource: input.discoverySource,
    conversationMessages: input.conversationMessages,
    recentFeedback: input.recentFeedback,
    latestIncomingMessage: input.incomingMessage.body,
    language: input.offer.toneConfig.language as string | undefined ?? "es",
  });

  const { draft } = await classifyAndDraft(input.llmProvider, context);

  return {
    conversation: { ...input.conversation, state: "pending_review", latestIntent: draft.branch, updatedAt: nowIso },
    draft,
    suppressionEntries: [...input.suppressionEntries],
    preRouterResult,
    usedLLM: true,
  };
}
