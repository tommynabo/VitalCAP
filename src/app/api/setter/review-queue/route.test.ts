import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSetterReviewQueuePageForWorkspace = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/lib/data/repository", () => ({ getSetterReviewQueuePageForWorkspace }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET } = await import("./route");
const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("GET /api/setter/review-queue", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getSetterReviewQueuePageForWorkspace.mockResolvedValue({ conversations: [], nextCursor: null });
  });

  it("loads the first page for the authenticated workspace", async () => {
    const response = await GET(new Request("http://localhost/api/setter/review-queue"));

    expect(response.status).toBe(200);
    expect(getSetterReviewQueuePageForWorkspace).toHaveBeenCalledWith(workspaceId, null);
  });

  it("validates and forwards a pagination cursor", async () => {
    const cursor = { id: "conversation-25", updatedAt: "2026-10-08T12:00:00.000Z" };
    const response = await GET(new Request(`http://localhost/api/setter/review-queue?cursor=${encodeURIComponent(JSON.stringify(cursor))}`));

    expect(response.status).toBe(200);
    expect(getSetterReviewQueuePageForWorkspace).toHaveBeenCalledWith(workspaceId, cursor);
  });

  it("rejects malformed cursors without querying queue data", async () => {
    const response = await GET(new Request("http://localhost/api/setter/review-queue?cursor=not-json"));

    expect(response.status).toBe(400);
    expect(getSetterReviewQueuePageForWorkspace).not.toHaveBeenCalled();
  });

  it("requires an authorized workspace member", async () => {
    requireWorkspaceMember.mockRejectedValue(new UnauthorizedError());
    const response = await GET(new Request("http://localhost/api/setter/review-queue"));

    expect(response.status).toBe(403);
    expect(getSetterReviewQueuePageForWorkspace).not.toHaveBeenCalled();
  });
});