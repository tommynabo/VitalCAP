import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccountListPageForWorkspace = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/lib/data/repository", () => ({ getAccountListPageForWorkspace }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET } = await import("./route");
const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("GET /api/accounts", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getAccountListPageForWorkspace.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("loads a list page only for the authenticated workspace", async () => {
    const response = await GET(new Request("http://localhost/api/accounts"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getAccountListPageForWorkspace).toHaveBeenCalledWith(workspaceId, null);
  });

  it("validates and forwards the cursor with workspace scope", async () => {
    const cursor = { createdAt: "2026-01-25T00:00:00.000Z", id: "account-25" };
    const response = await GET(new Request(`http://localhost/api/accounts?cursor=${encodeURIComponent(JSON.stringify(cursor))}`));

    expect(response.status).toBe(200);
    expect(getAccountListPageForWorkspace).toHaveBeenCalledWith(workspaceId, cursor);
  });

  it("rejects invalid cursors and requires workspace membership", async () => {
    const invalid = await GET(new Request("http://localhost/api/accounts?cursor=invalid"));
    expect(invalid.status).toBe(400);
    expect(getAccountListPageForWorkspace).not.toHaveBeenCalled();

    requireWorkspaceMember.mockRejectedValue(new UnauthorizedError());
    const unauthorized = await GET(new Request("http://localhost/api/accounts"));
    expect(unauthorized.status).toBe(403);
    expect(getAccountListPageForWorkspace).not.toHaveBeenCalled();
  });
});