import { describe, expect, it, vi } from "vitest";
import {
  buildConversationHistoryPage,
  mergeConversationHistoryPages,
  requestConversationHistoryOnExpand,
  type ConversationHistoryPage,
} from "./conversation-history";

function makeMessage(index: number) {
  return {
    id: `message-${String(index).padStart(3, "0")}`,
    conversationId: "conversation-1",
    direction: index % 2 === 0 ? "incoming" as const : "outgoing" as const,
    body: `Message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  };
}

describe("Setter conversation history", () => {
  it("returns a bounded chronological page and a cursor for older messages", () => {
    const newestFirst = Array.from({ length: 5 }, (_, index) => makeMessage(4 - index));
    const page = buildConversationHistoryPage(newestFirst, 3);

    expect(page.messages.map(({ id }) => id)).toEqual(["message-002", "message-003", "message-004"]);
    expect(page.nextCursor).toEqual({ id: "message-002", createdAt: makeMessage(2).createdAt });
  });

  it("caps the default history page at 50 messages", () => {
    const page = buildConversationHistoryPage(Array.from({ length: 51 }, (_, index) => makeMessage(50 - index)));

    expect(page.messages).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it("merges older pages chronologically without duplicating messages", () => {
    const newer: ConversationHistoryPage = { messages: [makeMessage(2), makeMessage(3)], nextCursor: null };
    const older: ConversationHistoryPage = { messages: [makeMessage(0), makeMessage(1), makeMessage(2)], nextCursor: null };

    expect(mergeConversationHistoryPages(newer, older).messages.map(({ id }) => id)).toEqual([
      "message-000", "message-001", "message-002", "message-003",
    ]);
  });

  it("does not request while collapsed and reuses the successful first page", async () => {
    const cache = new Map<string, Promise<ConversationHistoryPage>>();
    const requestPage = vi.fn(async () => ({ messages: [makeMessage(0)], nextCursor: null }));

    expect(requestConversationHistoryOnExpand(false, "conversation-1", cache, requestPage)).toBeNull();
    const firstRequest = requestConversationHistoryOnExpand(true, "conversation-1", cache, requestPage);
    const secondRequest = requestConversationHistoryOnExpand(true, "conversation-1", cache, requestPage);

    expect(secondRequest).toBe(firstRequest);
    await firstRequest;
    expect(requestPage).toHaveBeenCalledTimes(1);
  });

  it("clears failed requests so an expanded history can retry", async () => {
    const cache = new Map<string, Promise<ConversationHistoryPage>>();
    const requestPage = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ messages: [makeMessage(0)], nextCursor: null });

    await expect(requestConversationHistoryOnExpand(true, "conversation-1", cache, requestPage)).rejects.toThrow("temporary failure");
    await expect(requestConversationHistoryOnExpand(true, "conversation-1", cache, requestPage)).resolves.toMatchObject({
      messages: [makeMessage(0)],
    });
    expect(requestPage).toHaveBeenCalledTimes(2);
  });
});