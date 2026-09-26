/**
 * Domain types for discovery: durable job/queue models (Prompt 1 §1.1 job
 * tables, Prompt 2 §2.1–2.2) and the shared discovery engine contract every
 * engine (`MapsFastEngine`, `MapsDeepEngine`, `GoogleSerpEngine`,
 * `LinkedInOwnerEngine`, `HybridFillEngine`) must implement in Phase 2.
 */

import type { EngineType } from "@/domain/campaigns/types";
import type { AsyncMapsRun } from "@/domain/providers/types";

export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "dead_letter";

export interface JobRecord<TPayload = Record<string, unknown>> {
  id: string;
  campaignId: string;
  type: string;
  payload: TPayload;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  idempotencyKey?: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DiscoveryJob = JobRecord<{ engineType: EngineType; seedId?: string }>;
export type ProcessingJob = JobRecord<{ rawCandidateId: string }>;

export interface RawCandidate {
  id: string;
  campaignId: string;
  engineType: EngineType;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  rawPayload: Record<string, unknown>;
  searchSeedRunId?: string | null;
  providerRunId?: string | null;
  accountId?: string | null;
  discoveredAt: string;
}

export interface SearchSeed {
  id: string;
  campaignId: string;
  engineType: EngineType;
  query: string;
  geography: string;
  lastRunAt: string | null;
  totalRaw: number;
  totalUnique: number;
  totalReady: number;
  yieldRate: number;
  exhaustionScore: number;
  nextEligibleAt: string | null;
}

export interface SearchSeedRun {
  id: string;
  seedId: string;
  startedAt: string;
  finishedAt: string | null;
  rawCount: number;
  uniqueCount: number;
  readyCount: number;
  error: string | null;
}

/**
 * Shared discovery engine contract (Prompt 2 §2.1). `DiscoveryRouter` stays
 * thin and delegates to concrete engine implementations behind this
 * interface — engine-specific logic never leaks into the router.
 */
export interface DiscoveryEngine {
  readonly engineType: EngineType;
  readonly usesAsyncProvider?: boolean;
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] };
  planDiscoveryBatch(input: {
    campaignId: string;
    remainingTarget: number;
  }): Promise<{ seeds: SearchSeed[] }>;
  executeDiscovery(input: { seed: SearchSeed; dryRun: boolean; requestKey?: string; maxResults?: number }): Promise<{
    rawCandidates: RawCandidate[];
    providerCalls: number;
    providerErrors: number;
    latencyMs: number;
    providerRun?: AsyncMapsRun;
  }>;
}
