/**
 * Domain types for the Autopilot Target Engine (Prompt 2 §2.11). These
 * describe the state the `AutopilotScheduler` / `TargetPlanner` /
 * `QuotaRebalancer` / `QueueHealthService` / `ProviderHealthService` /
 * `PacingService` operate on. No scheduling logic lives here yet — Phase 2
 * implements the services; this module only fixes the shared vocabulary.
 */

import type { EngineType } from "@/domain/campaigns/types";

export type ProviderHealthStatus = "healthy" | "degraded" | "paused" | "unknown";
export type AutopilotTargetMetric = "qualified" | "analyzed_qualified" | "outreach_ready";

export type AutopilotEffectiveState = "running" | "paused" | "emergency_stopped";

export interface AutopilotSettings {
  workspaceId: string;
  enabled: boolean;
  emergencyStopped: boolean;
  globalDailyTarget: number;
  targetMetric: AutopilotTargetMetric;
  timezone: string;
  operatingStartHour: number | null;
  operatingEndHour: number | null;
  maxDailyApifySpendUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export function getEffectiveAutopilotState(settings: Pick<AutopilotSettings, "enabled" | "emergencyStopped">): AutopilotEffectiveState {
  if (settings.emergencyStopped) return "emergency_stopped";
  return settings.enabled ? "running" : "paused";
}

export interface EngineTargetState {
  engineType: EngineType;
  softTarget: number;
  readyToday: number;
  qualifiedToday?: number;
  rawQueueDepth: number;
  processingQueueDepth: number;
  currentYield: number;
  providerHealth: ProviderHealthStatus;
  lastRunAt: string | null;
  nextPlannedAction: string | null;
}

export interface GlobalAutopilotState {
  dailyTarget: number;
  readyToday: number;
  targetAchievedToday?: number;
  targetMetric?: AutopilotTargetMetric;
  sentToday: number;
  repliesToday: number;
  meetingsToday: number;
  readyBufferDays: number | null;
  systemHealth: ProviderHealthStatus;
  engines: EngineTargetState[];
}

export interface RebalanceDecision {
  id: string;
  createdAt: string;
  fromEngine: EngineType | null;
  toEngine: EngineType;
  amount: number;
  reason: string;
}
