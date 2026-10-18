import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentWorkspaceId, getWorkspaceRole, requireCurrentUser, runDiscoveryCronTick } = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  getWorkspaceRole: vi.fn(),
  requireCurrentUser: vi.fn(),
  runDiscoveryCronTick: vi.fn(),
}));

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  getCurrentWorkspaceId,
  requireCurrentUser,
}));
vi.mock("@/infrastructure/neon/repositories/workspace", () => ({ getWorkspaceRole }));
vi.mock("@/infrastructure/jobs/runners/discovery-runner", () => ({ runDiscoveryCronTick }));

const { POST } = await import("./route");

describe("POST /api/admin/discovery/run-one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentUser.mockResolvedValue({ userId: "admin-1" });
    getCurrentWorkspaceId.mockResolvedValue("workspace-1");
    getWorkspaceRole.mockResolvedValue("admin");
    runDiscoveryCronTick.mockResolvedValue({ jobsClaimed: 1, rawCandidatesProduced: 0 });
  });

  it("blocks unauthenticated requests before running discovery", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    requireCurrentUser.mockRejectedValue(new UnauthorizedError());

    const response = await POST(new Request("http://localhost/api/admin/discovery/run-one", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("blocks authenticated users without admin or owner role", async () => {
    getWorkspaceRole.mockResolvedValue("member");

    const response = await POST(new Request("http://localhost/api/admin/discovery/run-one", { method: "POST" }));

    expect(response.status).toBe(403);
    expect(runDiscoveryCronTick).not.toHaveBeenCalled();
  });

  it("runs one normal discovery tick and ignores arbitrary batch-size input", async () => {
    const request = new Request("http://localhost/api/admin/discovery/run-one", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSize: 5, campaignId: "untrusted" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(runDiscoveryCronTick).toHaveBeenCalledTimes(1);
    expect(runDiscoveryCronTick).toHaveBeenCalledWith(1);
    await expect(response.json()).resolves.toMatchObject({ ok: true, jobsClaimed: 1 });
  });
});