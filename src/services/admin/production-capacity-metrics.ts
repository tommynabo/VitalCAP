import type { EngineType } from "@/domain/campaigns/types";
import { evaluateInstantlyContactQuota } from "@/domain/providers/instantly-plan-guard";

export type CapacityWindow = "today" | "rolling3d" | "rolling7d";
export type CapacityStatus = "supported" | "blocked" | "unknown";
export type RampReadiness = "READY" | "BLOCKED" | "UNKNOWN";

export const DISCOVERY_ENGINE_TYPES: readonly EngineType[] = [
  "maps_fast",
  "maps_deep",
  "google_serp",
  "linkedin_owner",
  "hybrid_fill",
];

export function evaluateInstantlyDeliveryCapacity(input: {
  targetLeadsPerDay: number;
  planningDays: number;
  uploadedContacts: number | null;
  providerContactLimit: number | null;
  configuredContactHardLimit: number;
  monthlyEmailsSent: number | null;
  monthlyEmailLimit: number;
  followupEmailsPerLead: number | null;
  autoSendEnabled?: boolean;
}): {
  projectedNewContacts: number;
  effectiveContactHardLimit: number | null;
  remainingContactSlots: number | null;
  contactShortfall: number | null;
  contactRunwayDays: number | null;
  contactCapacityStatus: CapacityStatus;
  initialEmailsPerLead: 1;
  projectedInitialMonthlyEmails: number;
  projectedTotalMonthlyEmails: number | null;
  followupEmailsPerLead: number | null;
  monthlyEmailHeadroom: number | null;
  monthlyEmailShortfall: number | null;
  totalMonthlyEmailShortfall: number | null;
  initialEmailCapacityStatus: CapacityStatus;
  totalEmailCapacityStatus: CapacityStatus;
  supportsTarget: boolean | null;
} {
  const projectedNewContacts = input.targetLeadsPerDay * input.planningDays;
  const initialEmailsPerLead = 1 as const;
  const projectedInitialMonthlyEmails = projectedNewContacts * initialEmailsPerLead;
  const monthlyEmailHeadroom = input.monthlyEmailsSent === null
    ? null
    : Math.max(0, input.monthlyEmailLimit - input.monthlyEmailsSent);
  const contactQuota = input.uploadedContacts === null || input.providerContactLimit === null
    ? null
    : evaluateInstantlyContactQuota({
        uploadedContacts: input.uploadedContacts,
        providerLimit: input.providerContactLimit,
        configuredHardLimit: input.configuredContactHardLimit,
        warningThreshold: input.configuredContactHardLimit,
      });
  const remainingContactSlots = contactQuota?.remaining ?? null;
  const contactShortfall = remainingContactSlots === null
    ? null
    : Math.max(0, projectedNewContacts - remainingContactSlots);
  const contactCapacityStatus: CapacityStatus = remainingContactSlots === null
    ? "unknown"
    : contactShortfall! > 0 ? "blocked" : "supported";
  const initialEmailCapacityStatus: CapacityStatus = monthlyEmailHeadroom === null
    ? "unknown"
    : monthlyEmailHeadroom < projectedInitialMonthlyEmails ? "blocked" : "supported";
  const projectedTotalMonthlyEmails = input.followupEmailsPerLead === null
    ? null
    : Math.ceil(projectedNewContacts * (initialEmailsPerLead + input.followupEmailsPerLead));
  const totalEmailCapacityStatus: CapacityStatus = input.followupEmailsPerLead === null
    ? initialEmailCapacityStatus === "blocked" ? "blocked" : "unknown"
    : monthlyEmailHeadroom === null
      ? "unknown"
      : monthlyEmailHeadroom < projectedTotalMonthlyEmails! ? "blocked" : "supported";
  const contactRunwayDays = remainingContactSlots === null || input.targetLeadsPerDay <= 0
    ? null
    : remainingContactSlots / input.targetLeadsPerDay;
  const supportsTarget = contactCapacityStatus === "blocked" || totalEmailCapacityStatus === "blocked"
    ? false
    : contactCapacityStatus === "unknown" || totalEmailCapacityStatus === "unknown"
      ? null
      : true;

  return {
    projectedNewContacts,
    effectiveContactHardLimit: contactQuota?.hardLimit ?? null,
    remainingContactSlots,
    contactShortfall,
    contactRunwayDays,
    contactCapacityStatus,
    initialEmailsPerLead,
    projectedInitialMonthlyEmails,
    projectedTotalMonthlyEmails,
    followupEmailsPerLead: input.followupEmailsPerLead,
    monthlyEmailHeadroom,
    monthlyEmailShortfall: monthlyEmailHeadroom === null
      ? null
      : Math.max(0, projectedInitialMonthlyEmails - monthlyEmailHeadroom),
    totalMonthlyEmailShortfall: monthlyEmailHeadroom === null || projectedTotalMonthlyEmails === null
      ? null
      : Math.max(0, projectedTotalMonthlyEmails - monthlyEmailHeadroom),
    initialEmailCapacityStatus,
    totalEmailCapacityStatus,
    supportsTarget,
  };
}

export function evaluateRampReadiness(input: {
  deliveryCapacity: CapacityStatus;
  providersHealthy: boolean | null;
  paused: boolean | null;
  systemicDeadLetterCount: number | null;
  rawCapHealthy: boolean | null;
  yieldSampleCount: number | null;
  minimumYieldSamples?: number;
}): { decision: RampReadiness; blockers: string[]; unknowns: string[] } {
  const blockers: string[] = [];
  const unknowns: string[] = [];
  const check = (value: boolean | null, blocker: string) => {
    if (value === false) blockers.push(blocker);
    else if (value === null) unknowns.push(blocker);
  };

  check(input.deliveryCapacity === "blocked" ? false : input.deliveryCapacity === "unknown" ? null : true, "instantly_delivery_capacity");
  check(input.providersHealthy, "provider_health");
  check(input.paused === null ? null : !input.paused, "autopilot_pause_state");
  check(input.systemicDeadLetterCount === null ? null : input.systemicDeadLetterCount === 0, "systemic_dead_letters");
  check(input.rawCapHealthy, "raw_request_cap");
  check(
    input.yieldSampleCount === null ? null : input.yieldSampleCount >= (input.minimumYieldSamples ?? 3),
    "yield_sample_sufficiency",
  );

  return {
    decision: blockers.length > 0 ? "BLOCKED" : unknowns.length > 0 ? "UNKNOWN" : "READY",
    blockers,
    unknowns,
  };
}

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
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p25YieldUsed: number | null;
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
    return { p25: null, p50: null, p75: null, p90: null, p25YieldUsed: null, p50YieldUsed: null, p75YieldUsed: null, p90YieldUsed: null, sampleCount: demandSamples.length };
  }

  const percentile = (value: number) => demandSamples[Math.ceil(value * demandSamples.length) - 1]!;
  const p25 = percentile(0.25);
  const p50 = percentile(0.5);
  const p75 = percentile(0.75);
  const p90 = percentile(0.9);

  return {
    p25: p25.requests,
    p50: p50.requests,
    p75: p75.requests,
    p90: p90.requests,
    p25YieldUsed: p25.yield,
    p50YieldUsed: p50.yield,
    p75YieldUsed: p75.yield,
    p90YieldUsed: p90.yield,
    sampleCount: demandSamples.length,
  };
}

export interface CapacityScenario {
  expectedFinalYield: number | null;
  rawRequestsFor250: number | null;
  rawRequestsWith20PercentBuffer: number | null;
  apifyRequests: number | null;
  serperRequests: number | null;
  apifyDailyCostUsd: number | null;
  serperDailyCostUsd: number | null;
  verificationDailyCostUsd: number | null;
}

export function buildCapacityScenarios(input: {
  estimates: ReturnType<typeof estimateRequestsRequiredForTarget>;
  rolling7d: {
    finalYield: number | null;
    totalRequests: number;
    apifyRequests: number;
    serperRequests: number;
    apifySpendUsd: number;
    serperSpendUsd: number;
    verificationSpendUsd: number;
  };
}): Record<"CONSERVATIVE" | "BASE" | "OPTIMISTIC", CapacityScenario> {
  const settings = [
    { name: "CONSERVATIVE", requests: input.estimates.p90, yield: input.estimates.p90YieldUsed },
    {
      name: "BASE",
      requests: input.rolling7d.finalYield && input.rolling7d.finalYield > 0
        ? Math.ceil(250 / input.rolling7d.finalYield)
        : null,
      yield: input.rolling7d.finalYield,
    },
    { name: "OPTIMISTIC", requests: input.estimates.p25, yield: input.estimates.p25YieldUsed },
  ] as const;
  const totalProviderRequests = input.rolling7d.apifyRequests + input.rolling7d.serperRequests;

  return Object.fromEntries(settings.map(({ name, requests, yield: expectedFinalYield }) => {
    if (requests === null || expectedFinalYield === null) {
      return [name, {
        expectedFinalYield: null,
        rawRequestsFor250: null,
        rawRequestsWith20PercentBuffer: null,
        apifyRequests: null,
        serperRequests: null,
        apifyDailyCostUsd: null,
        serperDailyCostUsd: null,
        verificationDailyCostUsd: null,
      } satisfies CapacityScenario];
    }

    const bufferedRequests = Math.ceil(requests * 1.2);
    const providerMixDenominator = totalProviderRequests || input.rolling7d.totalRequests;
    const apifyShare = providerMixDenominator > 0
      ? input.rolling7d.apifyRequests / providerMixDenominator
      : 0;
    const apifyRequests = Math.round(bufferedRequests * apifyShare);
    const serperRequests = bufferedRequests - apifyRequests;
    const apifyDailyCostUsd = input.rolling7d.apifyRequests > 0
      ? apifyRequests * input.rolling7d.apifySpendUsd / input.rolling7d.apifyRequests
      : null;
    const serperDailyCostUsd = input.rolling7d.serperRequests > 0
      ? serperRequests * input.rolling7d.serperSpendUsd / input.rolling7d.serperRequests
      : null;
    const verificationDailyCostUsd = input.rolling7d.totalRequests > 0
      ? bufferedRequests * input.rolling7d.verificationSpendUsd / input.rolling7d.totalRequests
      : null;

    return [name, {
      expectedFinalYield,
      rawRequestsFor250: requests,
      rawRequestsWith20PercentBuffer: bufferedRequests,
      apifyRequests,
      serperRequests,
      apifyDailyCostUsd: apifyDailyCostUsd === null ? null : Number(apifyDailyCostUsd.toFixed(6)),
      serperDailyCostUsd: serperDailyCostUsd === null ? null : Number(serperDailyCostUsd.toFixed(6)),
      verificationDailyCostUsd: verificationDailyCostUsd === null ? null : Number(verificationDailyCostUsd.toFixed(6)),
    } satisfies CapacityScenario];
  })) as Record<"CONSERVATIVE" | "BASE" | "OPTIMISTIC", CapacityScenario>;
}