import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => ({
  select: vi.fn(),
  selectDistinct: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: () => ({ select: query.select, selectDistinct: query.selectDistinct }),
}));

import { getEmailVerificationUsage, getHealthWorkspaceIds } from "./diagnostics";

describe("getEmailVerificationUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.select.mockReturnValue({ from: query.from });
    query.selectDistinct.mockReturnValue({ from: query.from });
    query.from.mockReturnValue({ where: query.where, innerJoin: query.innerJoin });
    query.innerJoin.mockReturnValue({ where: query.where });
  });

  it.each([
    ["numeric string", "12.34", 12.34, "12.34"],
    ["number", 12.34, 12.34, "12.34"],
    ["zero string", "0", 0, "0.00"],
    ["null", null, 0, "0.00"],
    ["malformed value", "not-a-number", 0, "0.00"],
    ["non-finite value", "Infinity", 0, "0.00"],
  ])("normalizes costUsd from a %s database value", async (_label, costUsd, expected, formatted) => {
    query.where.mockResolvedValue([{
      calls: "3",
      items: 4,
      errors: "1",
      totalLatencyMs: "250",
      costUsd,
    }]);

    const result = await getEmailVerificationUsage("workspace-1");

    expect(result.costUsd).toBe(expected);
    expect(result.costUsd.toFixed(2)).toBe(formatted);
  });

  it("normalizes every numeric aggregate to the ProviderUsageStats number contract", async () => {
    query.where.mockResolvedValue([{
      calls: "3",
      items: "4",
      errors: "1",
      totalLatencyMs: "250",
      costUsd: "12.34",
    }]);

    const result = await getEmailVerificationUsage("workspace-1");

    expect(result).toEqual({
      calls: 3,
      items: 4,
      errors: 1,
      totalLatencyMs: 250,
      costUsd: 12.34,
      quotaRemaining: null,
    });
  });

  it("returns all distinct workspaces linked by mappings and target import history", async () => {
    query.where
      .mockResolvedValueOnce([{ workspaceId: "mapped-workspace" }, { workspaceId: "shared-workspace" }])
      .mockResolvedValueOnce([{ workspaceId: "import-workspace" }, { workspaceId: "shared-workspace" }]);

    await expect(getHealthWorkspaceIds("provider-campaign-id")).resolves.toEqual([
      "import-workspace",
      "mapped-workspace",
      "shared-workspace",
    ]);
    expect(query.selectDistinct).toHaveBeenCalledTimes(2);
  });

  it("uses target import history when no provider mapping exists", async () => {
    query.where
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ workspaceId: "import-workspace" }]);

    await expect(getHealthWorkspaceIds("provider-campaign-id")).resolves.toEqual(["import-workspace"]);
    expect(query.selectDistinct).toHaveBeenCalledTimes(2);
  });

  it("falls back to all active Autopilot workspaces when the target has no history", async () => {
    query.where
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ workspaceId: "workspace-b" }, { workspaceId: "workspace-a" }]);

    await expect(getHealthWorkspaceIds("provider-campaign-id")).resolves.toEqual(["workspace-a", "workspace-b"]);
    expect(query.selectDistinct).toHaveBeenCalledTimes(3);
  });
});