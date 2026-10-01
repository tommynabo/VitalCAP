import { beforeEach, describe, expect, it, vi } from "vitest";

const updateCampaign = vi.fn();
const createCampaign = vi.fn();
const getOfferById = vi.fn();
const getOrCreatePrimaryOffer = vi.fn();
const requireWorkspaceAdmin = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/infrastructure/neon/repositories/campaigns", () => ({ createCampaign, updateCampaign }));
vi.mock("@/infrastructure/neon/repositories/offers", () => ({ getOfferById, getOrCreatePrimaryOffer }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceAdmin }));

const { PATCH } = await import("./route");

const workspaceId = "00000000-0000-4000-8000-000000000001";
const campaignId = "00000000-0000-4000-8000-000000000002";
const updatedCampaign = {
  id: campaignId,
  workspaceId,
  offerId: "00000000-0000-4000-8000-000000000003",
  name: "Spain pharmacies",
  description: null,
  status: "paused",
  countryCode: "ES" as const,
  engineType: "maps_fast" as const,
  engineConfig: {},
  dailySoftTarget: 120,
  minimumFitScore: null,
  outreachProfileId: null,
  autopilotEnabled: false,
  desiredChannelMix: { email: 100, sms: 0 },
  timeZone: "Europe/Madrid",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:01:00.000Z",
};

describe("PATCH /api/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAdmin.mockResolvedValue({ workspaceId, user: { userId: "user_1" } });
    updateCampaign.mockResolvedValue(updatedCampaign);
  });

  it("updates only through the authenticated workspace scope", async () => {
    const response = await PATCH(new Request("http://localhost/api/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, status: "paused", autopilotEnabled: false, dailySoftTarget: 120 }),
    }));

    expect(response.status).toBe(200);
    expect(updateCampaign).toHaveBeenCalledWith({
      workspaceId,
      campaignId,
      patch: { status: "paused", autopilotEnabled: false, dailySoftTarget: 120 },
    });
    await expect(response.json()).resolves.toEqual({ campaign: updatedCampaign });
  });

  it("does not expose campaigns that are not in the authenticated workspace", async () => {
    updateCampaign.mockResolvedValue(null);
    const response = await PATCH(new Request("http://localhost/api/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, status: "active" }),
    }));

    expect(response.status).toBe(404);
  });
});
