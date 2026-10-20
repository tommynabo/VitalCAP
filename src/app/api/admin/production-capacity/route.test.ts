import { beforeEach, describe, expect, it, vi } from "vitest";

const requireWorkspaceOwner = vi.fn();
const getProductionCapacityDiagnostics = vi.fn();

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceOwner,
}));
vi.mock("@/infrastructure/neon/repositories/production-capacity-diagnostics", () => ({
  getProductionCapacityDiagnostics,
}));

const { GET } = await import("./route");

describe("/api/admin/production-capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1", role: "owner" });
    getProductionCapacityDiagnostics.mockResolvedValue({ workspaceId: "workspace-1", safeToRaiseCap: false });
  });

  it("requires owner authorization before reading diagnostics", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    requireWorkspaceOwner.mockRejectedValue(new UnauthorizedError());

    const response = await GET(new Request("https://example.test/api/admin/production-capacity"));

    expect(response.status).toBe(403);
    expect(getProductionCapacityDiagnostics).not.toHaveBeenCalled();
  });

  it("scopes diagnostics to the authorized workspace and disables caching", async () => {
    const response = await GET(new Request("https://example.test/api/admin/production-capacity"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getProductionCapacityDiagnostics).toHaveBeenCalledWith("workspace-1");
    await expect(response.json()).resolves.toEqual({ workspaceId: "workspace-1", safeToRaiseCap: false });
  });

  it("passes the exact valid cohort start through to diagnostics", async () => {
    const cohortStart = "2020-10-20T08:26:14.664Z";
    const response = await GET(new Request(`https://example.test/api/admin/production-capacity?recoveryAttributionCohortStart=${encodeURIComponent(cohortStart)}`));

    expect(response.status).toBe(200);
    expect(getProductionCapacityDiagnostics).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Date),
      new Date(cohortStart),
    );
  });

  it("rejects an invalid cohort start without querying diagnostics", async () => {
    const response = await GET(new Request("https://example.test/api/admin/production-capacity?recoveryAttributionCohortStart=not-a-date"));

    expect(response.status).toBe(400);
    expect(getProductionCapacityDiagnostics).not.toHaveBeenCalled();
  });
});