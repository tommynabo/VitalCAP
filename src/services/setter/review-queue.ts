import type { Account } from "@/domain/accounts/types";
import type { Campaign } from "@/domain/campaigns/types";
import type { Contact } from "@/domain/contacts/types";
import type { Conversation, ConversationMessage, SetterDraft } from "@/domain/conversations/types";

export const SETTER_REVIEW_QUEUE_LIMIT = 25;

export type SetterQueueCursor = Pick<Conversation, "id" | "updatedAt">;
export type SetterQueueConversation = Pick<Conversation, "id" | "accountId" | "contactId" | "campaignId" | "state" | "latestIntent" | "updatedAt">;
export type SetterQueueMessage = Pick<ConversationMessage, "id" | "conversationId" | "direction" | "body" | "createdAt">;
export type SetterQueueDraft = Pick<SetterDraft, "id" | "conversationMessageId" | "draft" | "confidence" | "riskFlags">;
export type SetterQueueAccount = {
  account: Pick<Account, "id" | "canonicalName">;
  contacts: Array<Pick<Contact, "id" | "firstName" | "fullName">>;
};
export type SetterQueueCampaign = Pick<Campaign, "id" | "name">;

export interface SetterReviewQueuePage {
  conversations: SetterQueueConversation[];
  latestInboundMessages: SetterQueueMessage[];
  messageCounts: Record<string, number>;
  setterDrafts: SetterQueueDraft[];
  accountBundles: SetterQueueAccount[];
  campaigns: SetterQueueCampaign[];
  pendingCount: number;
  oldestPendingAt: string | null;
  nextCursor: SetterQueueCursor | null;
}

export function mergeSetterReviewQueuePages(
  current: SetterReviewQueuePage,
  next: SetterReviewQueuePage,
): SetterReviewQueuePage {
  const mergeBy = <T, K extends string | number>(left: T[], right: T[], key: (item: T) => K): T[] => {
    const merged = new Map(left.map((item) => [key(item), item]));
    for (const item of right) merged.set(key(item), item);
    return [...merged.values()];
  };

  return {
    conversations: mergeBy(current.conversations, next.conversations, (item) => item.id),
    latestInboundMessages: mergeBy(current.latestInboundMessages, next.latestInboundMessages, (item) => item.id),
    messageCounts: { ...current.messageCounts, ...next.messageCounts },
    setterDrafts: mergeBy(current.setterDrafts, next.setterDrafts, (item) => item.id),
    accountBundles: mergeBy(current.accountBundles, next.accountBundles, (item) => item.account.id),
    campaigns: mergeBy(current.campaigns, next.campaigns, (item) => item.id),
    pendingCount: next.pendingCount,
    oldestPendingAt: next.oldestPendingAt,
    nextCursor: next.nextCursor,
  };
}

export interface SetterReviewQueueDependencies {
  listPendingConversations(limit: number, cursor: SetterQueueCursor | null): Promise<SetterQueueConversation[]>;
  listLatestInboundMessages(conversationIds: string[]): Promise<SetterQueueMessage[]>;
  countMessages(conversationIds: string[]): Promise<Record<string, number>>;
  listDrafts(messageIds: string[]): Promise<SetterQueueDraft[]>;
  listAccounts(accountIds: string[], contactIds: string[]): Promise<SetterQueueAccount[]>;
  listCampaigns(campaignIds: string[]): Promise<SetterQueueCampaign[]>;
  countPendingConversations(): Promise<number>;
  getOldestPendingAt(): Promise<string | null>;
}

export async function loadSetterReviewQueuePage(
  dependencies: SetterReviewQueueDependencies,
  cursor: SetterQueueCursor | null = null,
  pageSize = SETTER_REVIEW_QUEUE_LIMIT,
): Promise<SetterReviewQueuePage> {
  const [candidates, pendingCount, oldestPendingAt] = await Promise.all([
    dependencies.listPendingConversations(pageSize + 1, cursor),
    dependencies.countPendingConversations(),
    dependencies.getOldestPendingAt(),
  ]);
  const hasMore = candidates.length > pageSize;
  const pageConversations = candidates.slice(0, pageSize);

  if (pageConversations.length === 0) {
    return {
      conversations: [],
      latestInboundMessages: [],
      messageCounts: {},
      setterDrafts: [],
      accountBundles: [],
      campaigns: [],
      pendingCount,
      oldestPendingAt,
      nextCursor: null,
    };
  }

  const conversationIds = pageConversations.map((conversation) => conversation.id);
  const latestInboundMessages = await dependencies.listLatestInboundMessages(conversationIds);
  const latestInboundByConversation = new Map<string, SetterQueueMessage>();
  for (const message of latestInboundMessages) {
    if (message.direction !== "incoming") continue;
    latestInboundByConversation.set(message.conversationId, message);
  }

  const inboundMessageIds = pageConversations.flatMap((conversation) => {
    const message = latestInboundByConversation.get(conversation.id);
    return message ? [message.id] : [];
  });
  const drafts = inboundMessageIds.length > 0 ? await dependencies.listDrafts(inboundMessageIds) : [];
  const draftMessageIds = new Set(drafts.map((draft) => draft.conversationMessageId));
  const visibleConversations = pageConversations.filter((conversation) => {
    const latestInbound = latestInboundByConversation.get(conversation.id);
    return latestInbound !== undefined && draftMessageIds.has(latestInbound.id);
  });
  const visibleConversationIds = new Set(visibleConversations.map((conversation) => conversation.id));
  const visibleLatestInboundMessages = visibleConversations.flatMap((conversation) => {
    const message = latestInboundByConversation.get(conversation.id);
    return message ? [message] : [];
  });
  const messageCounts = visibleConversationIds.size > 0
    ? await dependencies.countMessages([...visibleConversationIds])
    : {};
  const draftByMessageId = new Map(drafts.map((draft) => [draft.conversationMessageId, draft]));
  const visibleDrafts = visibleConversations.flatMap((conversation) => {
    const inbound = latestInboundByConversation.get(conversation.id);
    const draft = inbound ? draftByMessageId.get(inbound.id) : null;
    return draft ? [draft] : [];
  });
  const accountIds = [...new Set(visibleConversations.map((conversation) => conversation.accountId))];
  const contactIds = [...new Set(visibleConversations.flatMap((conversation) => conversation.contactId ? [conversation.contactId] : []))];
  const campaignIds = [...new Set(visibleConversations.map((conversation) => conversation.campaignId))];
  const [accountBundles, campaigns] = await Promise.all([
    dependencies.listAccounts(accountIds, contactIds),
    dependencies.listCampaigns(campaignIds),
  ]);

  const lastConversation = pageConversations.at(-1);
  return {
    conversations: visibleConversations,
    latestInboundMessages: visibleLatestInboundMessages,
    messageCounts,
    setterDrafts: visibleDrafts,
    accountBundles,
    campaigns,
    pendingCount,
    oldestPendingAt,
    nextCursor: hasMore && lastConversation ? { id: lastConversation.id, updatedAt: lastConversation.updatedAt } : null,
  };
}