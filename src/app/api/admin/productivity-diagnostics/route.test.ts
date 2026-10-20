import { beforeEach, describe, expect, it, vi } from "vitest";

const requireWorkspaceOwner = vi.fn();
const getProductivityDiagnostics = vi.fn();

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceOwner,
}));
vi.mock("@/infrastructure/neon/repositories/productivity-diagnostics", () => ({
  getProductivityDiagnostics,
}));

const route = await import("./route");

describe("/api/admin/productivity-diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1", role: "owner" });
    getProductivityDiagnostics.mockResolvedValue({ timezone: "Europe/Madrid", autoSendEnabled: false });
  });

  it("requires owner authorization before querying diagnostics", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    requireWorkspaceOwner.mockRejectedValue(new UnauthorizedError());

    const response = await route.GET();

    expect(response.status).toBe(403);
    expect(getProductivityDiagnostics).not.toHaveBeenCalled();
  });

  it("scopes the no-store response to the authorized workspace", async () => {
    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getProductivityDiagnostics).toHaveBeenCalledWith("workspace-1");
    await expect(response.json()).resolves.toEqual({ timezone: "Europe/Madrid", autoSendEnabled: false });
  });

  it("exposes only GET and contains no provider-write route", () => {
    expect(Object.keys(route)).toEqual(["dynamic", "GET"]);
  });
});