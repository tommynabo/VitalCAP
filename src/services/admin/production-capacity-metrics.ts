import type { EngineType } from "@/domain/campaigns/types";

export type CapacityWindow = "today" | "rolling3d" | "rolling7d";

export const DISCOVERY_ENGINE_TYPES: readonly EngineType[] = [
  "maps_fast",
  "maps_deep",
  "google_serp",
  "linkedin_owner",
  "hybrid_fill",
];

export interface CapacityWindowBounds {
  start: Date;
  end: Date;
}

export interface ConfirmedImportFact {
  workspaceId: string;
  accountId: string;
  providerCampaignId: string;
  status: string;
  providerLeadId: string | null;
  uploadedAt: Date | null;
}

export interface AccountEngineSource {
  workspaceId: string;
  accountId: string;
  engineType: string;
  discoveredAt: Date;
}

export interface ConfirmedImportWindowRollup {
  sameCohortByEngine: Partial<Record<EngineType, number>>;
  backlogByEngine: Partial<Record<EngineType, number>>;
  multiSource: number;
  unattributed: number;
}

export interface ConfirmedImportRollup {
  byWindow: Record<CapacityWindow, ConfirmedImportWindowRollup>;
}

export function getCapacityWindowBounds(now: Date, todayStart: Date): Record<CapacityWindow, CapacityWindowBounds> {
  return {
    today: { start: todayStart, end: now },
    rolling3d: { start: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), end: now },
    rolling7d: { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now },
  };
}

export function isConfirmedTargetImport(
  row: ConfirmedImportFact,
  targetProviderCampaignId: string,
): row is ConfirmedImportFact & { uploadedAt: Date; providerLeadId: string } {
  return row.providerCampaignId === targetProviderCampaignId
    && row.status === "instantly_added"
    && row.providerLeadId !== null
    && row.uploadedAt !== null;
}

export function rollupConfirmedImports(input: {
  workspaceId: string;
  targetProviderCampaignId: string;
  now: Date;
  todayStart: Date;
  imports: readonly ConfirmedImportFact[];
  sources: readonly AccountEngineSource[];
}): ConfirmedImportRollup {
  const bounds = getCapacityWindowBounds(input.now, input.todayStart);
  const sourcesByAccount = new Map<string, Map<EngineType, Date[]>>();

  for (const source of input.sources) {
    if (source.workspaceId !== input.workspaceId || !DISCOVERY_ENGINE_TYPES.includes(source.engineType as EngineType)) continue;
    const sources = sourcesByAccount.get(source.accountId) ?? new Map<EngineType, Date[]>();
    const engine = source.engineType as EngineType;
    sources.set(engine, [...(sources.get(engine) ?? []), source.discoveredAt]);
    sourcesByAccount.set(source.accountId, sources);
  }

  const byWindow: ConfirmedImportRollup["byWindow"] = {} as ConfirmedImportRollup["byWindow"];
  for (const window of Object.keys(bounds) as CapacityWindow[]) {
    byWindow[window] = { sameCohortByEngine: {}, backlogByEngine: {}, multiSource: 0, unattributed: 0 };
  }

  for (const row of input.imports) {
    if (row.workspaceId !== input.workspaceId || !isConfirmedTargetImport(row, input.targetProviderCampaignId)) continue;

    for (const window of Object.keys(bounds) as CapacityWindow[]) {
      const { start, end } = bounds[window];
      if (row.uploadedAt < start || row.uploadedAt >= end) continue;

      const windowRollup = byWindow[window];
      const knownLineage = sourcesByAccount.get(row.accountId);
      const lineage = new Map(
        [...(knownLineage ?? [])]
          .map(([engine, sourceDates]) => [engine, sourceDates.filter((date) => date <= row.uploadedAt)] as const)
          .filter(([, sourceDates]) => sourceDates.length > 0),
      );
      if (lineage.size === 0) {
        windowRollup.unattributed++;
        continue;
      }
      if (lineage.size > 1) {
        windowRollup.multiSource++;
        continue;
      }

      const [engine, sourceDates] = [...lineage.entries()][0]!;
      const cohortSource = sourceDates.some((date) => date >= start && date < end && date <= row.uploadedAt);
      const destination = cohortSource ? windowRollup.sameCohortByEngine : windowRollup.backlogByEngine;
      destination[engine] = (destination[engine] ?? 0) + 1;
    }
  }

  return { byWindow };
}

export function totalConfirmedImports(rollup: ConfirmedImportWindowRollup): number {
  return Object.values(rollup.sameCohortByEngine).reduce((total, count) => total + (count ?? 0), 0)
    + Object.values(rollup.backlogByEngine).reduce((total, count) => total + (count ?? 0), 0)
    + rollup.multiSource
    + rollup.unattributed;
}

export function sameCohortYield(rollup: ConfirmedImportWindowRollup, requests: number): number | null {
  const imports = Object.values(rollup.sameCohortByEngine).reduce((total, count) => total + (count ?? 0), 0);
  return calculateYield(imports, requests);
}

export function calculateYield(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function calculateCostPerConfirmedImport(cost: number | null, confirmedImports: number): number | null {
  return cost !== null && Number.isFinite(cost) && confirmedImports > 0 ? cost / confirmedImports : null;
}

export function estimateRequestsRequiredForTarget(
  dailySamples: readonly { requests: number; confirmedImports: number }[],
  targetImports: number,
): {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p50YieldUsed: number | null;
  p75YieldUsed: number | null;
  p90YieldUsed: number | null;
  sampleCount: number;
} {
  const demandSamples = dailySamples
    .filter((sample) => sample.requests > 0 && sample.confirmedImports > 0)
    .map((sample) => ({
      requests: Math.ceil((sample.requests / sample.confirmedImports) * targetImports),
      yield: sample.confirmedImports / sample.requests,
    }))
    .sort((left, right) => left.requests - right.requests);
  if (demandSamples.length < 3) {
    return { p50: null, p75: null, p90: null, p50YieldUsed: null, p75YieldUsed: null, p90YieldUsed: null, sampleCount: demandSamples.length };
  }

  const percentile = (value: number) => demandSamples[Math.ceil(value * demandSamples.length) - 1]!;
  const p50 = percentile(0.5);
  const p75 = percentile(0.75);
  const p90 = percentile(0.9);

  return {
    p50: p50.requests,
    p75: p75.requests,
    p90: p90.requests,
    p50YieldUsed: p50.yield,
    p75YieldUsed: p75.yield,
    p90YieldUsed: p90.yield,
    sampleCount: demandSamples.length,
  };
}