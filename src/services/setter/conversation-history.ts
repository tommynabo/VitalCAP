import type { SetterQueueMessage } from "./review-queue";

export const CONVERSATION_HISTORY_PAGE_SIZE = 50;

export type ConversationHistoryCursor = Pick<SetterQueueMessage, "id" | "createdAt">;

export interface ConversationHistoryPage {
  messages: SetterQueueMessage[];
  nextCursor: ConversationHistoryCursor | null;
}

export function buildConversationHistoryPage(
  newestFirst: SetterQueueMessage[],
  pageSize = CONVERSATION_HISTORY_PAGE_SIZE,
): ConversationHistoryPage {
  const hasMore = newestFirst.length > pageSize;
  const messages = newestFirst.slice(0, pageSize).reverse();
  const oldest = messages[0];
  return {
    messages,
    nextCursor: hasMore && oldest ? { id: oldest.id, createdAt: oldest.createdAt } : null,
  };
}

export function mergeConversationHistoryPages(
  current: ConversationHistoryPage,
  older: ConversationHistoryPage,
): ConversationHistoryPage {
  const messagesById = new Map(current.messages.map((message) => [message.id, message]));
  for (const message of older.messages) messagesById.set(message.id, message);
  const messages = [...messagesById.values()].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
  );
  return { messages, nextCursor: older.nextCursor };
}

export function requestConversationHistoryOnExpand(
  expanded: boolean,
  conversationId: string,
  cache: Map<string, Promise<ConversationHistoryPage>>,
  requestPage: (conversationId: string) => Promise<ConversationHistoryPage>,
): Promise<ConversationHistoryPage> | null {
  if (!expanded) return null;
  const cached = cache.get(conversationId);
  if (cached) return cached;

  const request = requestPage(conversationId);
  cache.set(conversationId, request);
  void request.catch(() => {
    if (cache.get(conversationId) === request) cache.delete(conversationId);
  });
  return request;
}