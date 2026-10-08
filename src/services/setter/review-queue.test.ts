import { describe, expect, it, vi } from "vitest";
import type { SetterReviewQueueDependencies, SetterQueueConversation, SetterQueueMessage, SetterQueueDraft } from "./review-queue";
import { loadSetterReviewQueuePage, mergeSetterReviewQueuePages } from "./review-queue";

function makeConversation(index: number): SetterQueueConversation {
  return {
    id: `conversation-${index}`,
    accountId: `account-${index}`,
    contactId: `contact-${index}`,
    campaignId: `campaign-${index % 2}`,
    state: "pending_review",
    latestIntent: null,
    updatedAt: new Date(Date.UTC(2026, 9, 8, 12, 0, 0) - index * 60_000).toISOString(),
  };
}

function createDependencies(total: number, withoutDraftAt?: number): SetterReviewQueueDependencies {
  const conversations = Array.from({ length: total }, (_, index) => makeConversation(index));
  const messages: SetterQueueMessage[] = conversations.flatMap((conversation, index) => [
    {
      id: `old-inbound-${index}`,
      conversationId: conversation.id,
      direction: "incoming",
      body: "Earlier reply",
      createdAt: new Date(Date.parse(conversation.updatedAt) - 60_000).toISOString(),
    },
    {
      id: `latest-inbound-${index}`,
      conversationId: conversation.id,
      direction: "incoming",
      body: `Latest reply ${index}`,
      createdAt: conversation.updatedAt,
    },
  ]);
  const drafts: SetterQueueDraft[] = conversations.flatMap((conversation, index) => index === withoutDraftAt ? [] : [{
    id: `draft-${index}`,
    conversationMessageId: `latest-inbound-${index}`,
    draft: `Suggested response ${index}`,
    confidence: 0.9,
    riskFlags: [],
  }]);

  return {
    listPendingConversations: vi.fn(async (limit, cursor) => conversations
      .filter((conversation) => !cursor
        || conversation.updatedAt < cursor.updatedAt
        || (conversation.updatedAt === cursor.updatedAt && conversation.id < cursor.id))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, limit)),
    listLatestInboundMessages: vi.fn(async (ids: string[]) => {
      const latestByConversation = new Map<string, SetterQueueMessage>();
      for (const message of messages) {
        if (!ids.includes(message.conversationId) || message.direction !== "incoming") continue;
        const previous = latestByConversation.get(message.conversationId);
        if (!previous || Date.parse(message.createdAt) > Date.parse(previous.createdAt)) {
          latestByConversation.set(message.conversationId, message);
        }
      }
      return [...latestByConversation.values()];
    }),
    listMessages: vi.fn(async (ids) => messages.filter((message) => ids.includes(message.conversationId))),
    listDrafts: vi.fn(async (ids) => drafts.filter((draft) => ids.includes(draft.conversationMessageId))),
    listAccounts: vi.fn(async (ids: string[], contactIds: string[]) => ids.map((id) => ({
      account: { id, canonicalName: id },
      contacts: contactIds
        .filter((contactId) => contactId === `contact-${id.replace("account-", "")}`)
        .map((contactId) => ({ id: contactId, firstName: null, fullName: null })),
    }))),
    listCampaigns: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: id }))),
    countPendingConversations: vi.fn(async () => total),
    getOldestPendingAt: vi.fn(async () => conversations.at(-1)?.updatedAt ?? null),
  };
}

describe("Setter review queue loading", () => {
  it("limits the first page and scopes messages, drafts, accounts, and campaigns to visible items", async () => {
    const dependencies = createDependencies(31);
    const page = await loadSetterReviewQueuePage(dependencies);

    expect(dependencies.listPendingConversations).toHaveBeenCalledWith(26, null);
    expect(page.conversations).toHaveLength(25);
    expect(page.pendingCount).toBe(31);
    expect(page.nextCursor?.id).toBe("conversation-24");
    expect(dependencies.listMessages).toHaveBeenCalledWith(page.conversations.map(({ id }) => id));
    expect(page.conversationMessages).toHaveLength(50);
    expect(dependencies.listDrafts).toHaveBeenCalledWith(
      page.conversations.map((_, index) => `latest-inbound-${index}`),
    );
    expect(page.setterDrafts).toHaveLength(25);
    expect(dependencies.listAccounts).toHaveBeenCalledWith(
      page.conversations.map(({ accountId }) => accountId),
      page.conversations.map(({ contactId }) => contactId),
    );
    expect(dependencies.listCampaigns).toHaveBeenCalledWith(["campaign-0", "campaign-1"]);
  });

  it("loads the next page after the cursor and merges without dropping an existing selected item", async () => {
    const dependencies = createDependencies(31);
    const firstPage = await loadSetterReviewQueuePage(dependencies);
    const selectedId = firstPage.setterDrafts[7]?.id;
    const nextPage = await loadSetterReviewQueuePage(dependencies, firstPage.nextCursor);
    const merged = mergeSetterReviewQueuePages(firstPage, nextPage);

    expect(nextPage.conversations.map(({ id }) => id)).toEqual([
      "conversation-25", "conversation-26", "conversation-27", "conversation-28", "conversation-29", "conversation-30",
    ]);
    expect(merged.setterDrafts.some(({ id }) => id === selectedId)).toBe(true);
    expect(new Set(merged.conversations.map(({ id }) => id)).size).toBe(31);
    expect(merged.nextCursor).toBeNull();
  });

  it("loads histories only for draft-backed items and keeps pagination moving past incomplete candidates", async () => {
    const dependencies = createDependencies(4, 0);
    const firstPage = await loadSetterReviewQueuePage(dependencies, null, 2);

    expect(firstPage.conversations.map(({ id }) => id)).toEqual(["conversation-1"]);
    expect(firstPage.nextCursor?.id).toBe("conversation-1");
    expect(dependencies.listMessages).toHaveBeenCalledWith(["conversation-1"]);

    const selectedDraftId = firstPage.setterDrafts[0]?.id;
    const nextPage = await loadSetterReviewQueuePage(dependencies, firstPage.nextCursor, 2);
    const merged = mergeSetterReviewQueuePages(firstPage, nextPage);

    expect(nextPage.conversations.map(({ id }) => id)).toEqual(["conversation-2", "conversation-3"]);
    expect(merged.setterDrafts.some(({ id }) => id === selectedDraftId)).toBe(true);
    expect(merged.conversations.map(({ id }) => id)).toContain("conversation-1");
  });

  it("returns an empty page without querying child datasets", async () => {
    const dependencies = createDependencies(0);
    const page = await loadSetterReviewQueuePage(dependencies);

    expect(page.conversations).toEqual([]);
    expect(page.conversationMessages).toEqual([]);
    expect(page.setterDrafts).toEqual([]);
    expect(page.accountBundles).toEqual([]);
    expect(page.campaigns).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(dependencies.listMessages).not.toHaveBeenCalled();
    expect(dependencies.listDrafts).not.toHaveBeenCalled();
    expect(dependencies.listAccounts).not.toHaveBeenCalled();
    expect(dependencies.listCampaigns).not.toHaveBeenCalled();
  });
});