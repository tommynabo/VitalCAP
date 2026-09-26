import type { Campaign } from "@/domain/campaigns/types";

export interface DiscoveryOrder {
  workspaceId: string;
  campaignId: string;
  engineType: "maps_fast";
  desiredRawCount: number;
  reason: string;
  planningWindow: string;
  idempotencyKey: string;
  origin: "normal" | "rebalance" | "hybrid_fill";
}

export interface MapsFastAllocationInput {
  workspaceId: string;
  campaigns: readonly Campaign[];
  rawNeeded: number;
  reason: string;
  now: Date;
  timeZone: string;
  origin?: DiscoveryOrder["origin"];
}

export function planningWindowKey(now: Date, timeZone: string, windowMinutes = 15): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const minute = Math.floor(Number(values.minute ?? 0) / windowMinutes) * windowMinutes;
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${String(minute).padStart(2, "0")}`;
}

export function allocateMapsFastRawNeed(input: MapsFastAllocationInput): DiscoveryOrder[] {
  const eligible = input.campaigns.filter((campaign) => campaign.status === "active" && campaign.autopilotEnabled && campaign.engineType === "maps_fast" && campaign.dailySoftTarget > 0);
  const totalWeight = eligible.reduce((sum, campaign) => sum + campaign.dailySoftTarget, 0);
  if (input.rawNeeded <= 0 || totalWeight <= 0) return [];

  const window = planningWindowKey(input.now, input.timeZone);
  let remaining = Math.min(100, Math.ceil(input.rawNeeded));
  const orders: DiscoveryOrder[] = [];
  eligible.forEach((campaign, index) => {
    const share = index === eligible.length - 1 ? remaining : Math.min(remaining, Math.floor((input.rawNeeded * campaign.dailySoftTarget) / totalWeight));
    if (share <= 0) return;
    remaining -= share;
    orders.push({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      engineType: "maps_fast",
      desiredRawCount: share,
      reason: input.reason,
      planningWindow: window,
      idempotencyKey: `autopilot:${input.workspaceId}:${campaign.id}:${window}`,
      origin: input.origin ?? "normal",
    });
  });
  return orders;
}