import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { EngineCapability } from "./engine-capability";

export interface DiscoveryOrder {
  workspaceId: string;
  campaignId: string;
  engineType: EngineType;
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

export interface EnginePlanningPerformance {
  campaignId: string;
  /** Historical qualified/raw yield, bounded by the planner. */
  yield: number;
  queueDepth: number;
  seedExhaustion: number;
}

export interface EngineWorkAllocationInput extends Omit<MapsFastAllocationInput, "campaigns"> {
  campaigns: readonly Campaign[];
  capabilities: readonly EngineCapability[];
  performances?: readonly EnginePlanningPerformance[];
}

/**
 * One planning window may issue enough work for five independently tracked
 * Maps seed searches. This prevents a low 100-raw ceiling from starving a
 * 250-qualified daily target while retaining a bounded, idempotent unit of
 * work and leaving the daily safety cap to the provider reservation guard.
 */
export const MAX_RAW_PER_PLANNING_WINDOW = 500;

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
  return allocateEngineWork({
    ...input,
    capabilities: [{ engineType: "maps_fast", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: input.campaigns.length, reasonUnavailable: null, reason: null }],
  });
}

/**
 * Global, yield-aware allocation. `rawNeeded` is the single workspace
 * pacing deficit — it is intentionally not multiplied by the number of
 * engines. Engines without a healthy configured provider are excluded before
 * work is enqueued.
 */
export function allocateEngineWork(input: EngineWorkAllocationInput): DiscoveryOrder[] {
  const available = new Set(input.capabilities.filter((capability) => capability.available).map((capability) => capability.engineType));
  const performanceByCampaign = new Map((input.performances ?? []).map((performance) => [performance.campaignId, performance]));
  const eligible = input.campaigns.filter((campaign) => campaign.status === "active" && campaign.autopilotEnabled && campaign.engineType !== "hybrid_fill" && campaign.dailySoftTarget > 0 && available.has(campaign.engineType));
  if (input.rawNeeded <= 0 || eligible.length === 0) return [];

  const weighted = eligible.map((campaign) => {
    const performance = performanceByCampaign.get(campaign.id);
    const yieldWeight = Math.max(0.1, Math.min(1, performance?.yield ?? 0.25));
    const queuePenalty = Math.min(0.75, (performance?.queueDepth ?? 0) / 1_000);
    const exhaustionPenalty = Math.min(0.75, performance?.seedExhaustion ?? 0);
    return { campaign, weight: campaign.dailySoftTarget * yieldWeight * (1 - queuePenalty) * (1 - exhaustionPenalty) };
  }).filter((item) => item.weight > 0);
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return [];

  const window = planningWindowKey(input.now, input.timeZone);
  let remaining = Math.min(MAX_RAW_PER_PLANNING_WINDOW, Math.ceil(input.rawNeeded));
  return weighted.flatMap((item, index) => {
    const share = index === weighted.length - 1 ? remaining : Math.min(remaining, Math.floor((Math.min(MAX_RAW_PER_PLANNING_WINDOW, input.rawNeeded) * item.weight) / totalWeight));
    if (share <= 0) return [];
    remaining -= share;
    return [{
      workspaceId: input.workspaceId,
      campaignId: item.campaign.id,
      engineType: item.campaign.engineType,
      desiredRawCount: share,
      reason: input.reason,
      planningWindow: window,
      idempotencyKey: `autopilot:${input.workspaceId}:${item.campaign.id}:${window}`,
      origin: input.origin ?? "normal",
    }];
  });
}

export function rerouteEngineOrders(input: EngineWorkAllocationInput & {
  orders: readonly DiscoveryOrder[];
  fromEngine: EngineType;
  reason: string;
}): DiscoveryOrder[] {
  const divertedRaw = input.orders
    .filter((order) => order.engineType === input.fromEngine)
    .reduce((total, order) => total + order.desiredRawCount, 0);
  if (divertedRaw <= 0) return [...input.orders];

  const alternatives = allocateEngineWork({
    workspaceId: input.workspaceId,
    campaigns: input.campaigns.filter((campaign) => campaign.engineType !== input.fromEngine),
    capabilities: input.capabilities,
    performances: input.performances,
    rawNeeded: divertedRaw,
    reason: input.reason,
    now: input.now,
    timeZone: input.timeZone,
    origin: "hybrid_fill",
  });
  const combined = new Map<string, DiscoveryOrder>();
  for (const order of [...input.orders.filter((item) => item.engineType !== input.fromEngine), ...alternatives]) {
    const existing = combined.get(order.campaignId);
    if (!existing) {
      combined.set(order.campaignId, order);
      continue;
    }
    combined.set(order.campaignId, {
      ...existing,
      desiredRawCount: existing.desiredRawCount + order.desiredRawCount,
      reason: order.origin === "hybrid_fill" ? order.reason : existing.reason,
      origin: existing.origin === "hybrid_fill" || order.origin === "hybrid_fill" ? "hybrid_fill" : existing.origin,
    });
  }
  return [...combined.values()];
}
