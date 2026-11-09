import { NextResponse } from "next/server";
import { z } from "zod";
import type { Campaign, EngineType } from "@/domain/campaigns/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getCampaignById } from "@/infrastructure/neon/repositories/campaigns";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";
import { getScopedInstantlyTargetPreflight } from "@/infrastructure/neon/repositories/instantly-import-targets";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getScopedSmokeProviderRunDiagnostics, getTodaySpendUsd } from "@/infrastructure/neon/repositories/provider-runs";
import { getMultiNicheCampaignInventory, getScopedCampaignProviderSpend } from "@/infrastructure/neon/repositories/multi-niche-rollout";
import { getSeedEconomicPerformance, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { enqueueScopedSmokeJob, getScopedSmokeJob, persistScopedSmokeResult } from "@/infrastructure/neon/repositories/job-queue";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { COLD_START_IMPORT_SAMPLE, planningWindowKey, resolveOperationalEnvelope, routeCampaignsToAvailableEngines } from "@/services/autopilot/target-planner";
import { getMultiNicheRolloutEntry, MULTI_NICHE_ROLLOUT } from "@/services/autopilot/multi-niche-rollout";
import { hasConfidentSeedEconomicEvidence, scoreSeedEconomicPerformance } from "@/services/discovery/seed-economics";
import { getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
import { getDayBounds } from "@/lib/time/day-bounds";
import { AUTO_SEND_ENABLED } from "@/services/setter/autonomy-policy";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";
import { logEvent } from "@/lib/observability/structured-logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const requestSchema = z.object({
  campaignId: z.uuid(),
  dryRun: z.boolean().default(true),
  maxDiscoveryJobs: z.number().int().min(1).max(1).default(1),
  maxProviderQueries: z.literal(1).default(1),
  maxCandidates: z.number().int().min(1).max(5).default(3),
  probeMode: z.boolean().default(false),
  smokeExecutionId: z.uuid().optional(),
  allowImport: z.literal(false).default(false),
}).strict().superRefine((input, context) => {
  if (!input.dryRun && !input.probeMode) {
    context.addIssue({ code: "custom", path: ["probeMode"], message: "Real scoped smoke requires probeMode=true." });
  }
  if (!input.dryRun && !input.smokeExecutionId) {
    context.addIssue({ code: "custom", path: ["smokeExecutionId"], message: "Real scoped smoke requires an explicit execution UUID." });
  }
});

interface ScopedSmokePlan {
  campaign: Campaign;
  niche: string;
  target: string;
  providerEngine: EngineType;
  provider: "apify" | "serper";
  providerHealth: string;
  seed: { id: string; query: string; geography: string } | null;
  mappingBlockReason: string;
  verificationReady: boolean;
  verificationBlockReason: string | null;
  providerAvailable: boolean;
  operationalEnvelope: ReturnType<typeof resolveOperationalEnvelope>;
  coldStart: boolean;
  selectionReason: string;
}

async function buildScopedSmokePlan(campaignId: string, workspaceId: string): Promise<ScopedSmokePlan> {
  const rollout = getMultiNicheRolloutEntry(campaignId);
  if (!rollout) throw Object.assign(new Error("Campaign ID is not allowlisted for scoped smoke."), { status: 403 });

  const campaign = await getCampaignById(campaignId);
  if (!campaign || campaign.workspaceId !== workspaceId) {
    throw Object.assign(new Error("Campaign was not found in the current workspace."), { status: 404 });
  }
  if (campaign.engineConfig?.niche !== rollout.niche) {
    throw Object.assign(new Error("Campaign niche does not match the rollout allowlist."), { status: 409 });
  }
  if (campaign.status !== "draft" || campaign.autopilotEnabled) {
    throw Object.assign(new Error("Scoped smoke requires the campaign to remain Draft with autopilot disabled."), { status: 409 });
  }
  if (AUTO_SEND_ENABLED) {
    throw Object.assign(new Error("Scoped smoke is blocked while auto-send is enabled."), { status: 409 });
  }

  const target = await getScopedInstantlyTargetPreflight(campaignId, workspaceId);
  if (!target || target.niche !== rollout.niche || target.expectedTarget !== rollout.expectedTarget
    || target.actualTarget !== rollout.expectedTarget || target.mappingEnabled || target.importReady
    || target.blockReason !== "mapping_disabled") {
    throw Object.assign(new Error("Scoped smoke requires the exact disabled Instantly mapping for this niche."), { status: 409 });
  }

  const [capacity, settings] = await Promise.all([
    getProductionCapacityDiagnostics(workspaceId),
    getAutopilotSettings(workspaceId),
  ]);
  if (getEffectiveAutopilotState(settings) !== "running") {
    throw Object.assign(new Error("Workspace Autopilot must be running for a bounded discovery smoke."), { status: 409 });
  }

  const mapsEnv = getMapsEnv();
  const serperEnv = getSerperEnv();
  const verificationEnv = getVerificationEnv();
  const verificationSpend = await getTodaySpendUsd(workspaceId, "email_verification", settings.timezone);
  const verificationReady = verificationEnv.EMAIL_VERIFICATION_PROVIDER === "millionverifier"
    && Boolean(verificationEnv.MILLION_VERIFIER || verificationEnv.MILLIONVERIFIER_API_KEY)
    && verificationSpend < verificationEnv.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD;
  const mapsHealth = capacity.providerHealth.apify.reliability;
  const serperHealth = capacity.providerHealth.serper.reliability;
  const capabilities = buildEngineCapabilities({
    mapsProvider: mapsEnv.MAPS_PROVIDER,
    mapsProviderConfigured: Boolean(mapsEnv.APIFY_API_TOKEN),
    serpProvider: serperEnv.SERP_PROVIDER,
    serpProviderConfigured: Boolean(serperEnv.SERPER_API_KEY),
    mapsFastHealth: mapsHealth,
    providerHealth: {
      maps_fast: mapsHealth,
      maps_deep: mapsHealth,
      google_serp: serperHealth,
      linkedin_owner: serperHealth,
      hybrid_fill: mapsHealth === "healthy" || serperHealth === "healthy" ? "healthy" : "paused",
    },
    costAllowed: capacity.providerHealth.apify.budgetAllowed || capacity.providerHealth.serper.budgetAllowed,
    mapsCostAllowed: capacity.providerHealth.apify.budgetAllowed,
    serperCostAllowed: capacity.providerHealth.serper.budgetAllowed,
    campaignCounts: { maps_fast: 1, google_serp: 1 },
  });
  const routed = routeCampaignsToAvailableEngines([campaign], capabilities)[0];
  const providerEngine = routed?.engineType ?? campaign.engineType;
  const selectedCapability = capabilities.find((item) => item.engineType === providerEngine);
  const providerAvailable = Boolean(selectedCapability?.available);
  const seedSelectionTime = new Date();
  const [seeds, seedPerformance] = await Promise.all([
    listSearchSeedsForCampaignEngine(campaignId, providerEngine),
    getSeedEconomicPerformance(campaignId, providerEngine, seedSelectionTime, campaign.timeZone),
  ]);
  const eligibleSeeds = seeds.filter((item) => item.campaignId === campaignId && item.engineType === providerEngine
    && item.query.trim().length > 0 && item.geography.trim().length > 0
    && (!item.nextEligibleAt || new Date(item.nextEligibleAt).getTime() <= seedSelectionTime.getTime())
    && scoreSeedEconomicPerformance(item, seedPerformance.get(item.id), seedSelectionTime).eligible);
  const seed = eligibleSeeds.sort((left, right) => (left.lastRunAt ? 1 : 0) - (right.lastRunAt ? 1 : 0)
    || (left.lastRunAt ?? "").localeCompare(right.lastRunAt ?? "")
    || left.id.localeCompare(right.id))[0];
  if (!seed && providerAvailable) {
    throw Object.assign(new Error("No eligible persisted seed exists for the selected provider."), { status: 409 });
  }
  const coldStart = seed ? !hasConfidentSeedEconomicEvidence(seedPerformance.get(seed.id)) : false;
  const selectionReason = !providerAvailable
    ? "no_provider_available"
    : coldStart
      ? seed?.lastRunAt ? "insufficient_economic_sample" : "never_run_seed"
      : "economic_policy_eligible";

  const rolloutCampaigns = await Promise.all(MULTI_NICHE_ROLLOUT.map(async (entry) => {
    const item = entry.campaignId === campaignId ? campaign : await getCampaignById(entry.campaignId);
    if (!item || item.workspaceId !== workspaceId || item.engineConfig?.niche !== entry.niche
      || item.status !== "draft" || item.autopilotEnabled) {
      throw Object.assign(new Error("The four-campaign rollout scope is incomplete or inconsistent."), { status: 409 });
    }
    return item;
  }));
  const dayBounds = getDayBounds(settings.timezone);
  const rolloutStats = await getMultiNicheCampaignInventory(
    MULTI_NICHE_ROLLOUT.map((entry) => entry.campaignId),
    dayBounds.start,
    dayBounds.end,
  );
  if (rolloutStats.length !== MULTI_NICHE_ROLLOUT.length) {
    throw Object.assign(new Error("The shared rollout inventory snapshot is incomplete."), { status: 409 });
  }
  const statsByCampaign = new Map(rolloutStats.map((item) => [item.campaignId, item]));
  const routedRolloutCampaigns = routeCampaignsToAvailableEngines(rolloutCampaigns, capabilities);
  const routedByCampaign = new Map(routedRolloutCampaigns.map((item) => [item.id, item]));
  const operationalEnvelope = resolveOperationalEnvelope({
    businessDailyTarget: settings.globalDailyTarget,
    safeCapacityTarget: verificationReady ? capacity.operationalTarget.operationalDailyTarget : 0,
    backlogInventory: rolloutStats.reduce((total, item) => total + item.backlogInventory, 0),
    rawRequestedToday: rolloutStats.reduce((total, item) => total + item.rawRequestedToday, 0),
    campaigns: rolloutCampaigns.flatMap((item) => {
      const entry = getMultiNicheRolloutEntry(item.id);
      const stats = statsByCampaign.get(item.id);
      const routedCampaign = routedByCampaign.get(item.id);
      const providerCapability = capabilities.find((candidate) => candidate.engineType === routedCampaign?.engineType);
      if (!entry || !stats) return [];
      return [{
        campaign: item,
        confirmedImports: stats.confirmedImports,
        rawRequestedToday: stats.rawRequestedToday,
        completedProbeCount: stats.completedProbeCount,
        providerAvailable: Boolean(providerCapability?.available) && verificationReady,
      }];
    }),
  });

  return {
    campaign,
    niche: rollout.niche,
    target: rollout.expectedTarget,
    providerEngine,
    provider: providerEngine === "maps_fast" || providerEngine === "maps_deep" ? "apify" : "serper",
    providerHealth: !providerAvailable ? "unavailable" : selectedCapability?.providerUntested ? "untested" : "healthy",
    seed: seed ? { id: seed.id, query: seed.query, geography: seed.geography } : null,
    mappingBlockReason: target.blockReason,
    verificationReady,
    verificationBlockReason: verificationReady ? null : "MillionVerifier is disabled, unconfigured, or at its daily budget limit.",
    providerAvailable,
    operationalEnvelope,
    coldStart,
    selectionReason,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function replayScopedSmoke(job: Awaited<ReturnType<typeof getScopedSmokeJob>>) {
  if (!job) throw new Error("Scoped smoke job disappeared before replay.");
  const savedResult = asRecord(job.payload.scopedSmokeResult);
  const evidence = asRecord(job.payload.scopedSmokeEvidence) ?? {};
  const startedAt = typeof job.payload.startedAt === "string" ? new Date(job.payload.startedAt) : null;
  const providerSpendUsd = savedResult?.PROVIDER_SPEND_USD ?? (startedAt && Number.isFinite(startedAt.getTime())
    ? await getScopedCampaignProviderSpend(job.campaignId, startedAt)
    : null);
  const provider = String(savedResult?.PROVIDER ?? job.payload.provider ?? "unknown");
  const rollout = getMultiNicheRolloutEntry(job.campaignId);
  let progress = await getScopedSmokeProgress({
    campaignId: job.campaignId,
    smokeExecutionId: job.id,
    niche: rollout?.niche ?? null,
    provider,
    providerCallAttempted: savedResult?.PROVIDER_CALL_ATTEMPTED === true || evidence.providerCallAttempted === true,
    providerCallSucceeded: savedResult?.PROVIDER_CALL_SUCCEEDED === true || evidence.providerCallSucceeded === true,
    fallbackCandidatesInserted: savedResult?.RAW_CANDIDATES_INSERTED ?? evidence.rawCandidatesInserted,
      fallbackResultsReturned: savedResult?.RESULTS_RETURNED ?? evidence.resultsReturned,
    pollExistingRun: true,
  });
  let processing = null;
  const pendingCandidateIds = progress.ownershipExact
    ? progress.unprocessedCandidateIds.slice(0, Number(job.payload.maxCandidates ?? 5))
    : [];
  if (progress.resultsFinal && pendingCandidateIds.length > 0) {
    processing = await runProcessingCronTick(pendingCandidateIds.length, startedAt ?? new Date(), {
      campaignId: job.campaignId,
      allowScopedDraftCampaign: true,
      rawCandidateIds: pendingCandidateIds,
      enrichContacts: false,
      allowMapsFastWebsiteRecovery: false,
      correlationId: job.id,
      timeBudgetMs: 60_000,
    });
    progress = await getScopedSmokeProgress({
      campaignId: job.campaignId,
      smokeExecutionId: job.id,
      niche: rollout?.niche ?? null,
      provider,
      providerCallAttempted: savedResult?.PROVIDER_CALL_ATTEMPTED === true || evidence.providerCallAttempted === true,
      providerCallSucceeded: savedResult?.PROVIDER_CALL_SUCCEEDED === true || evidence.providerCallSucceeded === true,
      fallbackResultsReturned: savedResult?.RESULTS_RETURNED ?? evidence.resultsReturned,
      fallbackCandidatesInserted: savedResult?.RAW_CANDIDATES_INSERTED ?? evidence.rawCandidatesInserted,
      pollExistingRun: false,
    });
  }
  const payload = {
    ...(savedResult ?? {}),
    ok: true,
    dryRun: false,
    IDEMPOTENT_REPLAY: true,
    EXECUTION_STATE: job.status,
    SMOKE_EXECUTION_ID: job.id,
    JOB_ID: job.id,
    JOB_CLAIMED: evidence.jobClaimed === true || savedResult?.JOB_CLAIMED === true || job.attemptCount > 0,
    COLD_START: job.payload.coldStart === true || savedResult?.COLD_START === true,
    SELECTION_REASON: job.payload.selectionReason ?? savedResult?.SELECTION_REASON ?? null,
    PROVIDER_ENGINE: job.payload.engineType ?? null,
    PROVIDER_HEALTH: job.payload.providerHealth ?? null,
    SEED_ID: job.payload.seedId ?? null,
    SEED_QUERY: job.payload.seedQuery ?? null,
    GEOGRAPHY: job.payload.seedGeography ?? null,
    PROVIDER_CALL_ATTEMPTED: savedResult?.PROVIDER_CALL_ATTEMPTED === true || evidence.providerCallAttempted === true,
    PROVIDER_CALL_SUCCEEDED: savedResult?.PROVIDER_CALL_SUCCEEDED === true || evidence.providerCallSucceeded === true,
    PROVIDER_CALL_ERROR_CLASS: evidence.providerCallErrorClass ?? savedResult?.PROVIDER_CALL_ERROR_CLASS ?? null,
    PROVIDER_QUERIES_USED: evidence.providerQueriesUsed ?? savedResult?.PROVIDER_QUERIES_USED ?? 0,
    ...progress.response,
    DUPLICATES: Number(evidence.duplicates ?? 0) + Number(progress.response.DUPLICATE_COUNT ?? 0),
    CANDIDATE_COUNT: progress.response.RAW_CANDIDATES_INSERTED,
    processing,
    PROCESSING_STATUS: processing
      ? processing.jobsCompleted > 0 ? "COMPLETED" : "CLAIMED_NONE"
      : progress.response.PROCESSING_STATUS,
    PROVIDER_SPEND_USD: providerSpendUsd,
    IMPORT_ALLOWED: false,
    IMPORT_BLOCKED: true,
    AUTO_SEND_ENABLED,
  };
  await persistScopedSmokeResult({ jobId: job.id, campaignId: job.campaignId, result: payload });
  return NextResponse.json(payload, {
    status: progress.response.PROBE_STATUS === "PENDING" || job.status === "pending" || job.status === "processing" ? 202 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

const POLLABLE_PROVIDER_RUN_STATUSES = new Set(["starting", "queued", "running", "succeeded"]);
const PENDING_PROVIDER_RUN_STATUSES = new Set([...POLLABLE_PROVIDER_RUN_STATUSES, "ingesting"]);
const ROLLOUT_CAMPAIGN_IDS = new Set<string>(MULTI_NICHE_ROLLOUT.map((entry) => entry.campaignId));

async function getScopedSmokeProgress(input: {
  campaignId: string;
  smokeExecutionId: string;
  niche: string | null;
  provider: string;
  providerCallAttempted: boolean;
  providerCallSucceeded: boolean;
  fallbackCandidatesInserted: unknown;
  fallbackResultsReturned?: unknown;
  pollExistingRun: boolean;
}) {
  let diagnostics = await getScopedSmokeProviderRunDiagnostics(input.smokeExecutionId);
  const oneRun = diagnostics.runs.length === 1 ? diagnostics.runs[0] : null;
  const initialRunStatus = typeof oneRun?.status === "string" ? oneRun.status : null;
  if (input.pollExistingRun && input.provider === "apify" && oneRun
    && oneRun.campaign_id === input.campaignId
    && oneRun.discovery_job_id === input.smokeExecutionId
    && initialRunStatus && POLLABLE_PROVIDER_RUN_STATUSES.has(initialRunStatus)) {
    await runProviderRunsCronTick(1, { campaignId: input.campaignId, discoveryJobId: input.smokeExecutionId });
    diagnostics = await getScopedSmokeProviderRunDiagnostics(input.smokeExecutionId);
  }

  const runs = diagnostics.runs;
  const run = runs.length === 1 ? runs[0] : null;
  const providerRunStatus = typeof run?.status === "string" ? run.status : null;
  const candidateCampaignIds = new Set(diagnostics.candidates.map((candidate) => String(candidate.campaign_id)));
  const ownershipErrors = runs.filter((item) => item.campaign_id !== input.campaignId).length
    + diagnostics.candidates.filter((candidate) => candidate.campaign_id !== input.campaignId
      || (run && candidate.provider_run_id !== run.provider_run_id)).length;
  const legacyLeakageErrors = runs.filter((item) => !ROLLOUT_CAMPAIGN_IDS.has(String(item.campaign_id))).length
    + diagnostics.candidates.filter((candidate) => !ROLLOUT_CAMPAIGN_IDS.has(String(candidate.campaign_id))).length;
  const metadataNiche = typeof run?.metadata_niche === "string" ? run.metadata_niche : null;
  const campaignNiche = typeof run?.campaign_niche === "string" ? run.campaign_niche : null;
  const nicheMismatch = (metadataNiche !== null && input.niche !== null && metadataNiche !== input.niche)
    || (campaignNiche !== null && input.niche !== null && campaignNiche !== input.niche);
  const ownershipExact = runs.length === 1
    ? ownershipErrors === 0 && legacyLeakageErrors === 0 && !nicheMismatch
    : runs.length === 0 && diagnostics.candidates.length === 0 && input.provider !== "apify";
  const resultIsFinal = input.provider === "apify"
    ? providerRunStatus === "ingested"
    : input.providerCallAttempted && input.providerCallSucceeded;
  const providerRunFailure = providerRunStatus === "failed" || providerRunStatus === "aborted"
    || providerRunStatus === "timed_out" || providerRunStatus === "manual_reconciliation_required";
  const probeStatus = runs.length > 1 || ownershipErrors > 0 || legacyLeakageErrors > 0 || nicheMismatch
    ? "FAILED"
    : providerRunStatus === "budget_blocked"
      ? "BUDGET_BLOCKED"
      : providerRunFailure
        ? "FAILED"
        : input.provider === "apify" && !run && input.providerCallSucceeded
          ? "PENDING"
          : input.provider === "apify" && PENDING_PROVIDER_RUN_STATUSES.has(providerRunStatus ?? "")
            ? "PENDING"
            : resultIsFinal
              ? input.provider === "apify" && Number(run?.items_returned ?? 0) === 0 ? "FINAL_ZERO_RESULTS" : "INGESTED"
              : input.providerCallAttempted && !input.providerCallSucceeded ? "FAILED" : "QUEUED";
  const accounting = asRecord(run?.ingestion_accounting) ?? {};
  const insertedFromAccounting = Number(accounting.INSERTED_NEW_RAW);
  const resultsReturned = resultIsFinal
    ? input.provider === "apify" ? Number(run?.items_returned ?? 0) : Number(input.fallbackResultsReturned ?? 0)
    : input.provider === "apify" ? null : Number(input.fallbackResultsReturned ?? 0);
  const rawCandidatesInserted = input.provider === "apify"
    ? Number.isFinite(insertedFromAccounting) ? insertedFromAccounting : 0
    : Number(input.fallbackCandidatesInserted ?? 0);
  const unprocessedCandidateIds = diagnostics.candidates
    .filter((candidate) => candidate.campaign_id === input.campaignId
      && (!run || candidate.provider_run_id === run.provider_run_id)
      && candidate.processed !== true)
    .map((candidate) => String(candidate.id));
    const accountIds = diagnostics.candidates
      .map((candidate) => typeof candidate.account_id === "string" ? candidate.account_id : null)
      .filter((accountId): accountId is string => accountId !== null);
    const duplicateAccountCount = accountIds.length - new Set(accountIds).size;
  const response = {
    SOURCE_CAMPAIGN_ID: input.campaignId,
    NICHE: input.niche,
    PROVIDER: input.provider,
    PROVIDER_RUN_ID: run?.provider_run_id ?? null,
    EXTERNAL_PROVIDER_RUN_ID: run?.external_run_id ?? null,
    PROVIDER_DATASET_ID: run?.external_dataset_id ?? null,
    PROVIDER_RUN_STARTED_AT: run?.started_at ?? null,
    PROVIDER_SEED_ID: run?.metadata_seed_id ?? run?.seed_id ?? null,
    PROVIDER_RUN_CAMPAIGN_ID: run?.campaign_id ?? null,
    PROVIDER_RUN_NICHE: metadataNiche ?? campaignNiche,
    PROVIDER_RUN_NICHE_METADATA: metadataNiche,
    PROVIDER_CAMPAIGN_NICHE: campaignNiche,
    PROVIDER_RUN_STATUS: providerRunStatus,
    PROVIDER_FINAL_STATUS: providerRunStatus && !PENDING_PROVIDER_RUN_STATUSES.has(providerRunStatus)
      ? providerRunStatus
      : null,
    PROBE_STATUS: probeStatus,
    RESULTS_FINAL: resultIsFinal,
    RESULTS_RETURNED: resultsReturned,
    DATASET_ITEMS: resultIsFinal && input.provider === "apify" ? Number(run?.items_returned ?? 0) : null,
    RAW_CANDIDATES_INSERTED: rawCandidatesInserted,
    RAW_CANDIDATES_LINKED: diagnostics.candidates.length,
      RAW_CANDIDATE_IDS: diagnostics.candidates.map((candidate) => candidate.id),
      CANDIDATE_CLASSIFICATION: diagnostics.candidates.map((candidate) => {
        const outcome = asRecord(candidate.processing_outcome) ?? {};
        return {
          candidateId: candidate.id,
          campaignId: candidate.campaign_id,
          providerRunId: candidate.provider_run_id,
          businessType: outcome.businessType ?? candidate.business_type ?? null,
          physicalPresenceVerdict: outcome.physicalPresenceVerdict ?? null,
          icpQualified: outcome.icpQualified ?? null,
          duplicate: outcome.duplicate ?? null,
          matchedExistingAccount: outcome.matchedExistingAccount ?? null,
          countryCode: candidate.account_country_code ?? null,
          hasPostalCode: Boolean(candidate.account_postal_code),
          hasCoordinates: candidate.has_coordinates === true,
          processed: candidate.processed === true,
          campaignMembershipStage: candidate.campaign_membership_stage ?? null,
          qualified: candidate.campaign_membership_stage === "qualified"
            || candidate.campaign_membership_stage === "ready",
        };
      }),
    RAW_CANDIDATE_CAMPAIGNS: [...candidateCampaignIds].map((campaignId) => ({
      campaignId,
      count: diagnostics.candidates.filter((candidate) => String(candidate.campaign_id) === campaignId).length,
    })),
    ENTITY_FINGERPRINTS: diagnostics.candidates.map((candidate) => candidate.source_fingerprint),
    CROSS_CAMPAIGN_OWNERSHIP_ERRORS: ownershipErrors + (nicheMismatch ? 1 : 0),
    LEGACY_LEAKAGE_ERRORS: legacyLeakageErrors,
    PROCESSING_STATUS: diagnostics.candidates.length === 0
      ? "NOT_STARTED"
      : diagnostics.candidates.every((candidate) => candidate.processed === true) ? "COMPLETED" : "PENDING",
    QUALIFIED_COUNT: diagnostics.candidates.filter((candidate) => candidate.campaign_membership_stage === "qualified"
      || candidate.campaign_membership_stage === "ready").length,
    DUPLICATE_COUNT: Number(accounting.DUPLICATE_EXISTING_RAW ?? 0) + duplicateAccountCount,
    OWNERSHIP_EXACT: ownershipExact,
  };
  return { response, ownershipExact, unprocessedCandidateIds, resultsFinal: resultIsFinal };
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const workspaceId = await getCurrentWorkspaceId();
    const role = await getWorkspaceRole(workspaceId, user.userId);
    if (role !== "admin" && role !== "owner") {
      return NextResponse.json({ error: "Workspace admin authorization required." }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid scoped smoke request.", details: parsed.error.issues }, { status: 400 });
    }
    const input = parsed.data;
    let existingJob = null;
    if (!input.dryRun && input.smokeExecutionId) {
      existingJob = await getScopedSmokeJob(input.smokeExecutionId);
      if (existingJob) {
        if (existingJob.campaignId !== input.campaignId
          || existingJob.payload.smokeExecutionId !== input.smokeExecutionId) {
          return NextResponse.json({ error: "Smoke execution ID is already bound to another campaign or request." }, { status: 409 });
        }
        const existingCampaign = await getCampaignById(existingJob.campaignId);
        if (!existingCampaign || existingCampaign.workspaceId !== workspaceId) {
          return NextResponse.json({ error: "Smoke execution was not found in the current workspace." }, { status: 404 });
        }
        if (existingJob.status !== "pending" || existingJob.payload.scopedSmokeEvidence) {
          return replayScopedSmoke(existingJob);
        }
      }
    }
    const plan = await buildScopedSmokePlan(input.campaignId, workspaceId);
    if (existingJob && (
      existingJob.payload.engineType !== plan.providerEngine
      || existingJob.payload.seedId !== plan.seed?.id
      || existingJob.payload.seedQuery !== plan.seed?.query
      || existingJob.payload.seedGeography !== plan.seed?.geography
      || existingJob.payload.maxCandidates !== input.maxCandidates
      || existingJob.payload.maxProviderQueries !== input.maxProviderQueries
      || existingJob.payload.probeMode !== input.probeMode
      || existingJob.payload.scopedSmoke !== true
    )) {
      return NextResponse.json({ error: "Smoke execution ID is bound to different persisted probe options." }, { status: 409 });
    }
    const base = {
      SOURCE_CAMPAIGN_ID: plan.campaign.id,
      NICHE: plan.niche,
      EXPECTED_INSTANTLY_TARGET: plan.target,
      PROVIDER: plan.provider,
      PROVIDER_ENGINE: plan.providerEngine,
      PROVIDER_HEALTH: plan.providerHealth,
      DISCOVERY_PROVIDER_AVAILABLE: plan.providerAvailable,
      COLD_START: plan.coldStart,
      SELECTION_REASON: plan.selectionReason,
      SEED_ID: plan.seed?.id ?? null,
      SEED_QUERY: plan.seed?.query ?? null,
      GEOGRAPHY: plan.seed?.geography ?? null,
      OPERATIONAL_ENVELOPE: {
        scope: "multi_niche_rollout_global",
        campaignIds: MULTI_NICHE_ROLLOUT.map((entry) => entry.campaignId),
        ...plan.operationalEnvelope,
      },
      COLD_START_POLICY: {
        enabled: true,
        minimumConfirmedImportsBeforeEconomicAllocation: COLD_START_IMPORT_SAMPLE,
        permanentEqualShare: false,
      },
      LEGACY_FALLBACK_USED: false,
      GLOBAL_SIDE_EFFECTS: false,
      SEED: plan.seed,
      IMPORT_BLOCKED: true,
      IMPORT_BLOCK_REASON: plan.mappingBlockReason,
      IMPORT_ALLOWED: false,
      VERIFICATION_READY: plan.verificationReady,
      VERIFICATION_BLOCK_REASON: plan.verificationBlockReason,
      AUTO_SEND_ENABLED,
      CAMPAIGN_STATUS: plan.campaign.status,
      CAMPAIGN_AUTOPILOT_ENABLED: plan.campaign.autopilotEnabled,
    };
    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        ...base,
        SMOKE_EXECUTION_ID: input.smokeExecutionId ?? null,
        JOB_ID: null,
        JOB_CLAIMED: false,
        PROVIDER_CALL_ATTEMPTED: false,
        PROVIDER_CALL_SUCCEEDED: false,
        PROVIDER_CALL_ERROR_CLASS: null,
        PROVIDER_QUERIES_USED: 0,
        RESULTS_RETURNED: 0,
        RAW_CANDIDATES_INSERTED: 0,
        DUPLICATES: 0,
        CANDIDATE_COUNT: 0,
        candidateCount: 0,
        PROVIDER_SPEND_USD: 0,
        providerSpendUsd: 0,
      }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!plan.providerAvailable || !plan.seed) {
      throw Object.assign(new Error("Scoped smoke is blocked because no healthy provider and eligible persisted seed are available."), { status: 409 });
    }
    const startedAt = new Date();
    const smokeExecutionId = input.smokeExecutionId!;
    const payload = {
      engineType: plan.providerEngine,
      desiredRawCount: input.maxCandidates,
      maxCandidates: input.maxCandidates,
      maxProviderQueries: input.maxProviderQueries,
      probeMode: true,
      smokeExecutionId,
      seedId: plan.seed.id,
      startedAt: startedAt.toISOString(),
      planningWindow: planningWindowKey(startedAt, plan.campaign.timeZone),
      reason: "Admin scoped cold-start smoke.",
      origin: "normal" as const,
      seedQuery: plan.seed.query,
      seedGeography: plan.seed.geography,
      scopedSmoke: true,
      provider: plan.provider,
      providerHealth: plan.providerHealth,
      coldStart: plan.coldStart,
      selectionReason: plan.selectionReason,
    };
    const enqueueResult = existingJob
      ? { created: false, job: existingJob }
      : await enqueueScopedSmokeJob({
        jobId: smokeExecutionId,
        campaignId: plan.campaign.id,
        payload,
      });
    existingJob = enqueueResult.job;
    if (!enqueueResult.created && (existingJob.status !== "pending" || existingJob.payload.scopedSmokeEvidence)) {
      return replayScopedSmoke(existingJob);
    }
    const discovery = await runDiscoveryCronTick(1, new Date(), {
      campaignId: plan.campaign.id,
      jobId: smokeExecutionId,
      allowScopedDraftCampaign: true,
      probeMode: true,
      smokeExecutionId,
    });
    const evidence = discovery.scopedProbeEvidence;
    if (!evidence?.jobClaimed) {
      const currentJob = await getScopedSmokeJob(smokeExecutionId);
      return replayScopedSmoke(currentJob);
    }
    const providerRuns = evidence.providerCallAttempted && evidence.providerCallSucceeded && plan.provider === "apify"
      ? await runProviderRunsCronTick(1, { campaignId: plan.campaign.id, discoveryJobId: smokeExecutionId })
      : null;
    let progress = await getScopedSmokeProgress({
      campaignId: plan.campaign.id,
      smokeExecutionId,
      niche: plan.niche,
      provider: plan.provider,
      providerCallAttempted: evidence.providerCallAttempted,
      providerCallSucceeded: evidence.providerCallSucceeded,
      fallbackResultsReturned: evidence.resultsReturned,
      fallbackCandidatesInserted: evidence.rawCandidatesInserted,
      pollExistingRun: false,
    });
    const pendingCandidateIds = progress.ownershipExact
      ? progress.unprocessedCandidateIds.slice(0, input.maxCandidates)
      : [];
    const processing = progress.response.RESULTS_FINAL && pendingCandidateIds.length > 0
      ? await runProcessingCronTick(pendingCandidateIds.length, startedAt, {
        campaignId: plan.campaign.id,
        allowScopedDraftCampaign: true,
        rawCandidateIds: pendingCandidateIds,
        enrichContacts: false,
        allowMapsFastWebsiteRecovery: false,
        correlationId: smokeExecutionId,
        timeBudgetMs: 60_000,
      })
      : null;
    if (processing) {
      progress = await getScopedSmokeProgress({
        campaignId: plan.campaign.id,
        smokeExecutionId,
        niche: plan.niche,
        provider: plan.provider,
        providerCallAttempted: evidence.providerCallAttempted,
        providerCallSucceeded: evidence.providerCallSucceeded,
        fallbackResultsReturned: evidence.resultsReturned,
        fallbackCandidatesInserted: evidence.rawCandidatesInserted,
        pollExistingRun: false,
      });
    }
    const candidateCount = Math.min(input.maxCandidates, progress.response.RAW_CANDIDATES_INSERTED);
    const duplicates = evidence.duplicates + progress.response.DUPLICATE_COUNT;
    const returnedResults = progress.response.RESULTS_RETURNED;
    const providerSpendUsd = await getScopedCampaignProviderSpend(plan.campaign.id, startedAt);
    logEvent("info", "admin.scoped_multi_niche_smoke.completed", {
      correlationId: smokeExecutionId,
      workspaceId,
      campaignId: plan.campaign.id,
      niche: plan.niche,
      provider: plan.provider,
      providerEngine: plan.providerEngine,
      seedId: plan.seed.id,
      discoveryJobsClaimed: discovery?.jobsClaimed ?? 0,
      candidatesInserted: discovery?.rawCandidatesInserted ?? 0,
      providerRunsChecked: providerRuns?.runsChecked ?? 0,
      providerRunsIngested: providerRuns?.runsIngested ?? 0,
      processingJobsCompleted: processing?.jobsCompleted ?? 0,
      verificationJobsClaimed: 0,
      importsAllowed: false,
      autoSendEnabled: AUTO_SEND_ENABLED,
    });
    const responsePayload = {
      ok: true,
      dryRun: false,
      ...base,
      SMOKE_EXECUTION_ID: smokeExecutionId,
      JOB_ID: smokeExecutionId,
      JOB_CLAIMED: evidence.jobClaimed,
      PROVIDER_CALL_ATTEMPTED: evidence.providerCallAttempted,
      PROVIDER_CALL_SUCCEEDED: evidence.providerCallSucceeded,
      PROVIDER_CALL_ERROR_CLASS: evidence.providerCallErrorClass,
      PROVIDER_QUERIES_USED: Math.min(1, evidence.providerQueriesUsed),
      ...progress.response,
      RESULTS_RETURNED: returnedResults,
      RAW_CANDIDATES_INSERTED: progress.response.RAW_CANDIDATES_INSERTED,
      DUPLICATES: duplicates,
      CANDIDATE_COUNT: candidateCount,
      IMPORT_ALLOWED: false,
      discoveryJobId: smokeExecutionId,
      discovery,
      providerRuns,
      processing,
      PROCESSING_STATUS: processing
        ? processing.jobsCompleted > 0 ? "COMPLETED" : "CLAIMED_NONE"
        : progress.response.PROCESSING_STATUS,
      verification: null,
      VERIFICATION_SKIPPED_REASON: "Scoped async discovery does not trigger email verification.",
      candidateCount,
      discoverySkippedReason: evidence.providerCallAttempted ? null : evidence.providerCallErrorClass ?? "No provider call was attempted.",
      PROVIDER_SPEND_USD: providerSpendUsd,
      providerSpendUsd,
    };
    await persistScopedSmokeResult({
      jobId: smokeExecutionId,
      campaignId: plan.campaign.id,
      result: responsePayload,
    });
    return NextResponse.json(responsePayload, {
      status: progress.response.PROBE_STATUS === "PENDING" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Scoped smoke failed.",
    }, { status: status >= 400 && status < 600 ? status : 500 });
  }
}