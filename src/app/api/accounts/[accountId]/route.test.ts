import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccountBundleForWorkspace = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/lib/data/repository", () => ({ getAccountBundleForWorkspace }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET } = await import("./route");
const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";

describe("GET /api/accounts/[accountId]", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getAccountBundleForWorkspace.mockResolvedValue({ account: { id: accountId }, contacts: [], sources: [], contactPoints: [] });
  });

  it("loads one detail bundle for the authenticated workspace only", async () => {
    const response = await GET(new Request(`http://localhost/api/accounts/${accountId}`), {
      params: Promise.resolve({ accountId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getAccountBundleForWorkspace).toHaveBeenCalledWith(workspaceId, accountId);
  });

  it("hides accounts outside the active workspace and requires membership", async () => {
    getAccountBundleForWorkspace.mockResolvedValue(null);
    const missing = await GET(new Request(`http://localhost/api/accounts/${accountId}`), {
      params: Promise.resolve({ accountId }),
    });
    expect(missing.status).toBe(404);

    requireWorkspaceMember.mockRejectedValue(new UnauthorizedError());
    const unauthorized = await GET(new Request(`http://localhost/api/accounts/${accountId}`), {
      params: Promise.resolve({ accountId }),
    });
    expect(unauthorized.status).toBe(403);
    expect(getAccountBundleForWorkspace).toHaveBeenCalledTimes(1);
  });
});