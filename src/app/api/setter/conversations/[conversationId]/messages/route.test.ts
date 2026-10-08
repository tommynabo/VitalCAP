import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSetterConversationHistoryForWorkspace = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/lib/data/repository", () => ({ getSetterConversationHistoryForWorkspace }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET } = await import("./route");
const workspaceId = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ conversationId: "conversation-1" }) };

describe("GET /api/setter/conversations/[conversationId]/messages", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getSetterConversationHistoryForWorkspace.mockResolvedValue({ messages: [], nextCursor: null });
  });

  it("loads the first history page for the authenticated workspace", async () => {
    const response = await GET(new Request("http://localhost/api/setter/conversations/conversation-1/messages"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getSetterConversationHistoryForWorkspace).toHaveBeenCalledWith(workspaceId, "conversation-1", null);
  });

  it("validates and forwards the older-page cursor", async () => {
    const cursor = { id: "message-50", createdAt: "2026-10-08T12:00:00.000Z" };
    const response = await GET(new Request(`http://localhost/api/setter/conversations/conversation-1/messages?cursor=${encodeURIComponent(JSON.stringify(cursor))}`), context);

    expect(response.status).toBe(200);
    expect(getSetterConversationHistoryForWorkspace).toHaveBeenCalledWith(workspaceId, "conversation-1", cursor);
  });

  it("returns 404 for conversations that are not in the authorized workspace", async () => {
    getSetterConversationHistoryForWorkspace.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/setter/conversations/foreign/messages"), {
      params: Promise.resolve({ conversationId: "foreign" }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects malformed cursors and unauthenticated requests", async () => {
    const invalid = await GET(new Request("http://localhost/api/setter/conversations/conversation-1/messages?cursor=invalid"), context);
    expect(invalid.status).toBe(400);
    expect(getSetterConversationHistoryForWorkspace).not.toHaveBeenCalled();

    requireWorkspaceMember.mockRejectedValue(new UnauthorizedError());
    const unauthorized = await GET(new Request("http://localhost/api/setter/conversations/conversation-1/messages"), context);
    expect(unauthorized.status).toBe(403);
    expect(getSetterConversationHistoryForWorkspace).not.toHaveBeenCalled();
  });
});