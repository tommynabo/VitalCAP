import type { Campaign, EngineType } from "@/domain/campaigns/types";
import type { EngineCapability } from "./engine-capability";
import { SAFE_ENGINE_YIELD_PRIOR, type EngineYieldTier } from "./engine-performance";

export interface DiscoveryOrder {
  workspaceId: string;
  campaignId: string;
  engineType: EngineType;
  desiredRawCount: number;
  reason: string;
  planningWindow: string;
  idempotencyKey: string;
  origin: "normal" | "rebalance" | "hybrid_fill" | "recovery_probe";
  rebalanceAmount?: number;
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
  /** Recent end-to-end yield selected from the engine performance hierarchy. */
  yield: number;
  yieldTier?: EngineYieldTier;
  rawCount?: number;
  confirmedImportCount?: number;
  importRawYield?: number | null;
  estimatedProviderCostUsd?: number | null;
  costPerConfirmedImportUsd?: number | null;
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
export const MAX_APIFY_RECOVERY_PROBE_RAW = 10;
export const MIN_IMPORTS_FOR_COST_WEIGHT = 5;
const COST_WEIGHT_FLOOR = 0.75;
const COST_WEIGHT_CEILING = 1.25;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null;
}

function confirmedImportCostWeight(
  performance: EnginePlanningPerformance | undefined,
  medianCostPerImport: number | null,
): number {
  const costPerImport = performance?.costPerConfirmedImportUsd;
  if (
    (performance?.confirmedImportCount ?? 0) < MIN_IMPORTS_FOR_COST_WEIGHT
    || costPerImport === null || costPerImport === undefined || costPerImport <= 0
    || medianCostPerImport === null || medianCostPerImport <= 0
  ) return 1;

  const relativeWeight = Math.sqrt(medianCostPerImport / costPerImport);
  return Math.max(COST_WEIGHT_FLOOR, Math.min(COST_WEIGHT_CEILING, relativeWeight));
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

export function planApifyRecoveryProbe(input: {
  workspaceId: string;
  campaigns: readonly Campaign[];
  rawNeeded: number;
  eligible: boolean;
  dailyBudgetAllowed: boolean;
  cooldownAt: Date | null;
  credentialFingerprint: string;
  failureEpoch: string;
  now: Date;
  timeZone: string;
}): DiscoveryOrder[] {
  if (!input.eligible || !input.dailyBudgetAllowed || !input.cooldownAt || input.rawNeeded <= 0) return [];
  const campaign = input.campaigns
    .filter((item) => item.status === "active" && item.autopilotEnabled && item.dailySoftTarget > 0
      && (item.engineType === "maps_fast" || item.engineType === "maps_deep"))
    .sort((left, right) => {
      const engineOrder = (left.engineType === "maps_fast" ? 0 : 1) - (right.engineType === "maps_fast" ? 0 : 1);
      return engineOrder || left.id.localeCompare(right.id);
    })[0];
  if (!campaign) return [];

  const desiredRawCount = Math.min(
    MAX_APIFY_RECOVERY_PROBE_RAW,
    MAX_RAW_PER_PLANNING_WINDOW,
    Math.ceil(input.rawNeeded),
  );
  if (desiredRawCount <= 0) return [];
  const planningWindow = planningWindowKey(input.now, input.timeZone);
  return [{
    workspaceId: input.workspaceId,
    campaignId: campaign.id,
    engineType: campaign.engineType,
    desiredRawCount,
    reason: "Apify recovery probe after provider cooldown.",
    planningWindow,
    idempotencyKey: `apify-recovery-probe:${input.workspaceId}:${campaign.id}:${input.credentialFingerprint}:${input.failureEpoch}`,
    origin: "recovery_probe",
  }];
}

export function resolvePlanningWindow(plannedWindow: string | undefined, now: Date, timeZone: string): string {
  const currentWindow = planningWindowKey(now, timeZone);
  return plannedWindow && plannedWindow > currentWindow ? plannedWindow : currentWindow;
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
  const medianCostPerImport = median(eligible
    .map((campaign) => performanceByCampaign.get(campaign.id))
    .filter((performance): performance is EnginePlanningPerformance => performance !== undefined
      && (performance.confirmedImportCount ?? 0) >= MIN_IMPORTS_FOR_COST_WEIGHT
      && performance.costPerConfirmedImportUsd !== null
      && performance.costPerConfirmedImportUsd !== undefined
      && performance.costPerConfirmedImportUsd > 0)
    .map((performance) => performance.costPerConfirmedImportUsd!));

  const weighted = eligible.map((campaign) => {
    const performance = performanceByCampaign.get(campaign.id);
    const yieldWeight = Math.max(0, Math.min(1, performance?.yield ?? SAFE_ENGINE_YIELD_PRIOR));
    const queuePenalty = Math.min(0.75, (performance?.queueDepth ?? 0) / 1_000);
    const exhaustionPenalty = Math.min(0.75, performance?.seedExhaustion ?? 0);
    const costWeight = confirmedImportCostWeight(performance, medianCostPerImport);
    return { campaign, weight: campaign.dailySoftTarget * yieldWeight * (1 - queuePenalty) * (1 - exhaustionPenalty) * costWeight };
  });
  let totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    for (const item of weighted) {
      const performance = performanceByCampaign.get(item.campaign.id);
      const queuePenalty = Math.min(0.75, (performance?.queueDepth ?? 0) / 1_000);
      const exhaustionPenalty = Math.min(0.75, performance?.seedExhaustion ?? 0);
      item.weight = item.campaign.dailySoftTarget * (1 - queuePenalty) * (1 - exhaustionPenalty);
    }
    totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  }
  if (totalWeight <= 0) return [];
  const allocationWeights = weighted.filter((item) => item.weight > 0);
  totalWeight = allocationWeights.reduce((sum, item) => sum + item.weight, 0);

  const window = planningWindowKey(input.now, input.timeZone);
  let remaining = Math.min(MAX_RAW_PER_PLANNING_WINDOW, Math.ceil(input.rawNeeded));
  return allocationWeights.flatMap((item, index) => {
    const share = index === allocationWeights.length - 1 ? remaining : Math.min(remaining, Math.floor((Math.min(MAX_RAW_PER_PLANNING_WINDOW, input.rawNeeded) * item.weight) / totalWeight));
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
  fromEngine?: EngineType;
  fromCampaignIds?: readonly string[];
  alternativeCampaignIds?: readonly string[];
  reason: string;
}): DiscoveryOrder[] {
  const fromCampaignIds = input.fromCampaignIds ? new Set(input.fromCampaignIds) : null;
  const alternativeCampaignIds = input.alternativeCampaignIds ? new Set(input.alternativeCampaignIds) : null;
  const shouldReroute = (order: DiscoveryOrder) => fromCampaignIds
    ? fromCampaignIds.has(order.campaignId)
    : order.engineType === input.fromEngine;
  const divertedRaw = input.orders
    .filter(shouldReroute)
    .reduce((total, order) => total + order.desiredRawCount, 0);
  if (divertedRaw <= 0) return [...input.orders];

  const alternatives = allocateEngineWork({
    workspaceId: input.workspaceId,
    campaigns: input.campaigns.filter((campaign) => campaign.engineType !== "hybrid_fill"
      && (!fromCampaignIds ? campaign.engineType !== input.fromEngine : !fromCampaignIds.has(campaign.id))
      && (!alternativeCampaignIds || alternativeCampaignIds.has(campaign.id))),
    capabilities: input.capabilities,
    performances: input.performances,
    rawNeeded: divertedRaw,
    reason: input.reason,
    now: input.now,
    timeZone: input.timeZone,
    origin: "hybrid_fill",
  });
  const combined = new Map<string, DiscoveryOrder>();
  for (const order of [
    ...input.orders.filter((item) => !shouldReroute(item)),
    ...alternatives.map((item) => ({ ...item, rebalanceAmount: item.desiredRawCount })),
  ]) {
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
      rebalanceAmount: (existing.rebalanceAmount ?? 0) + (order.rebalanceAmount ?? 0),
    });
  }
  return [...combined.values()];
}
