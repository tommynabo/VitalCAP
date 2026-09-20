/**
 * Domain types for the Autopilot Target Engine (Prompt 2 §2.11). These
 * describe the state the `AutopilotScheduler` / `TargetPlanner` /
 * `QuotaRebalancer` / `QueueHealthService` / `ProviderHealthService` /
 * `PacingService` operate on. No scheduling logic lives here yet — Phase 2
 * implements the services; this module only fixes the shared vocabulary.
 */

import type { EngineType } from "@/domain/campaigns/types";

export type ProviderHealthStatus = "healthy" | "degraded" | "paused" | "unknown";

export interface EngineTargetState {
  engineType: EngineType;
  softTarget: number;
  readyToday: number;
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
  sentToday: number;
  repliesToday: number;
  meetingsToday: number;
  readyBufferDays: number;
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
