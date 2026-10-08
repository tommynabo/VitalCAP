import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOutreachQueuePageDataForWorkspace = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/lib/data/repository", () => ({ getOutreachQueuePageDataForWorkspace }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET } = await import("./route");
const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("GET /api/outreach/queue", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getOutreachQueuePageDataForWorkspace.mockResolvedValue({ items: [], accounts: [], contactPoints: [], nextCursor: null });
  });

  it("loads a requested queue tab for the authenticated workspace", async () => {
    const response = await GET(new Request("http://localhost/api/outreach/queue?tab=failed"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getOutreachQueuePageDataForWorkspace).toHaveBeenCalledWith(workspaceId, "failed", null, { channel: undefined, campaignId: undefined });
  });

  it("validates and forwards a cursor without changing workspace scope", async () => {
    const cursor = { id: "queue-25" };
    const response = await GET(new Request(`http://localhost/api/outreach/queue?tab=scheduled&cursor=${encodeURIComponent(JSON.stringify(cursor))}`));

    expect(response.status).toBe(200);
    expect(getOutreachQueuePageDataForWorkspace).toHaveBeenCalledWith(workspaceId, "scheduled", cursor, { channel: undefined, campaignId: undefined });
  });

  it("passes the existing campaign and channel filters into the page query", async () => {
    const response = await GET(new Request("http://localhost/api/outreach/queue?tab=scheduled&channel=email&campaignId=campaign-1"));

    expect(response.status).toBe(200);
    expect(getOutreachQueuePageDataForWorkspace).toHaveBeenCalledWith(
      workspaceId,
      "scheduled",
      null,
      { channel: "email", campaignId: "campaign-1" },
    );
  });

  it("rejects invalid tabs/cursors and requires a workspace member", async () => {
    const invalidTab = await GET(new Request("http://localhost/api/outreach/queue?tab=unknown"));
    expect(invalidTab.status).toBe(400);
    const invalidCursor = await GET(new Request("http://localhost/api/outreach/queue?tab=scheduled&cursor=invalid"));
    expect(invalidCursor.status).toBe(400);
    expect(getOutreachQueuePageDataForWorkspace).not.toHaveBeenCalled();

    requireWorkspaceMember.mockRejectedValue(new UnauthorizedError());
    const unauthorized = await GET(new Request("http://localhost/api/outreach/queue?tab=scheduled"));
    expect(unauthorized.status).toBe(403);
    expect(getOutreachQueuePageDataForWorkspace).not.toHaveBeenCalled();
  });
});