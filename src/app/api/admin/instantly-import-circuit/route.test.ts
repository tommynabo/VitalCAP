import { beforeEach, describe, expect, it, vi } from "vitest";

const getInstantlyImportCircuitState = vi.fn();
const resetInstantlyImportCircuit = vi.fn();
const requireWorkspaceOwner = vi.fn();
const getDeliveryEnv = vi.fn();
const isDevSeedMode = vi.fn();

vi.mock("@/infrastructure/neon/repositories/instantly-lead-imports", () => ({
  getInstantlyImportCircuitState,
  resetInstantlyImportCircuit,
}));
vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceOwner,
}));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv, isDevSeedMode }));

const { GET, POST } = await import("./route");

describe("/api/admin/instantly-import-circuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1", user: { userId: "owner-1" } });
    getDeliveryEnv.mockReturnValue({ INSTANTLY_CAMPAIGN_ID: "provider-campaign-1" });
    isDevSeedMode.mockReturnValue(false);
    getInstantlyImportCircuitState.mockResolvedValue({ open: false, trippedAt: null });
    resetInstantlyImportCircuit.mockResolvedValue({ reset: true });
  });

  it("requires workspace owner authorization to read circuit state", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(getInstantlyImportCircuitState).toHaveBeenCalledWith("provider-campaign-1", "workspace-1");
  });

  it("does not access the Neon circuit in seed mode", async () => {
    isDevSeedMode.mockReturnValue(true);

    const response = await GET();

    expect(response.status).toBe(409);
    expect(getInstantlyImportCircuitState).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and resets only through the repository", async () => {
    const response = await POST(new Request("http://localhost/api/admin/instantly-import-circuit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }));

    expect(response.status).toBe(200);
    expect(resetInstantlyImportCircuit).toHaveBeenCalledWith({
      providerCampaignId: "provider-campaign-1",
      workspaceId: "workspace-1",
      actorUserId: "owner-1",
    });
    expect(getInstantlyImportCircuitState).toHaveBeenCalledWith("provider-campaign-1", "workspace-1");
  });

  it("does not reset without confirmation", async () => {
    const response = await POST(new Request("http://localhost/api/admin/instantly-import-circuit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(400);
    expect(resetInstantlyImportCircuit).not.toHaveBeenCalled();
  });
});