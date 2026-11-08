import { NextResponse } from "next/server";
import { z } from "zod";
import type { Campaign, EngineType } from "@/domain/campaigns/types";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getCampaignById } from "@/infrastructure/neon/repositories/campaigns";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";
import { getScopedInstantlyTargetPreflight } from "@/infrastructure/neon/repositories/instantly-import-targets";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getTodaySpendUsd } from "@/infrastructure/neon/repositories/provider-runs";
import { getScopedCampaignProviderSpend } from "@/infrastructure/neon/repositories/multi-niche-rollout";
import { listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { enqueueDiscoveryJob } from "@/infrastructure/neon/repositories/job-queue";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";
import { enqueueVerificationJobs, runVerificationCronTick } from "@/infrastructure/jobs/runners/verification-runner";
import { buildEngineCapabilities } from "@/services/autopilot/engine-capability";
import { planningWindowKey, routeCampaignsToAvailableEngines } from "@/services/autopilot/target-planner";
import { getMultiNicheRolloutEntry } from "@/services/autopilot/multi-niche-rollout";
import { getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
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
  maxCandidates: z.number().int().min(1).max(5).default(3),
  allowImport: z.literal(false).default(false),
}).strict();

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
  const seeds = await listSearchSeedsForCampaignEngine(campaignId, providerEngine);
  const seed = [...seeds]
    .filter((item) => !item.nextEligibleAt || new Date(item.nextEligibleAt).getTime() <= Date.now())
    .sort((left, right) => (left.lastRunAt ?? "").localeCompare(right.lastRunAt ?? "") || left.id.localeCompare(right.id))[0];
  if (!seed && providerAvailable) {
    throw Object.assign(new Error("No eligible persisted seed exists for the selected provider."), { status: 409 });
  }

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
  };
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
    const plan = await buildScopedSmokePlan(input.campaignId, workspaceId);
    const base = {
      SOURCE_CAMPAIGN_ID: plan.campaign.id,
      NICHE: plan.niche,
      EXPECTED_INSTANTLY_TARGET: plan.target,
      PROVIDER: plan.provider,
      PROVIDER_ENGINE: plan.providerEngine,
      PROVIDER_HEALTH: plan.providerHealth,
      DISCOVERY_PROVIDER_AVAILABLE: plan.providerAvailable,
      SEED: plan.seed,
      IMPORT_BLOCKED: true,
      IMPORT_BLOCK_REASON: plan.mappingBlockReason,
      VERIFICATION_READY: plan.verificationReady,
      VERIFICATION_BLOCK_REASON: plan.verificationBlockReason,
      AUTO_SEND_ENABLED,
      CAMPAIGN_STATUS: plan.campaign.status,
      CAMPAIGN_AUTOPILOT_ENABLED: plan.campaign.autopilotEnabled,
    };
    if (input.dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, ...base, candidateCount: 0, providerSpendUsd: 0 }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const startedAt = new Date();
    const discoveryJobId = plan.providerAvailable && plan.seed
      ? await enqueueDiscoveryJob({
        campaignId: plan.campaign.id,
        type: "run_engine_batch",
        payload: {
          engineType: plan.providerEngine,
          desiredRawCount: input.maxCandidates,
          planningWindow: planningWindowKey(startedAt, plan.campaign.timeZone),
          reason: "Admin scoped multi-niche smoke.",
          origin: "normal",
          seedQuery: plan.seed.query,
          seedGeography: plan.seed.geography,
          scopedSmoke: true,
        },
        idempotencyKey: `scoped-smoke:${plan.campaign.id}:multi-niche-rollout-v1`,
      })
      : null;
    const discovery = discoveryJobId
      ? await runDiscoveryCronTick(1, startedAt, {
        campaignId: plan.campaign.id,
        jobId: discoveryJobId,
        allowScopedDraftCampaign: true,
      })
      : null;
    const providerRuns = discoveryJobId && plan.provider === "apify"
      ? await runProviderRunsCronTick(1, { campaignId: plan.campaign.id, discoveryJobId })
      : null;
    const processing = await runProcessingCronTick(input.maxCandidates, startedAt, {
      campaignId: plan.campaign.id,
      allowScopedDraftCampaign: true,
      enrichContacts: true,
      timeBudgetMs: 60_000,
    });
    await enqueueVerificationJobs({
      campaignId: plan.campaign.id,
      allowScopedDraftCampaign: true,
      createdSince: startedAt,
      batchSize: input.maxCandidates,
    });
    const verification = await runVerificationCronTick(input.maxCandidates, {
      campaignId: plan.campaign.id,
      allowScopedDraftCampaign: true,
      skipInstantlyImport: true,
    });
    const providerSpendUsd = await getScopedCampaignProviderSpend(plan.campaign.id, startedAt);
    logEvent("info", "admin.scoped_multi_niche_smoke.completed", {
      correlationId: discoveryJobId ?? `scoped-smoke:${plan.campaign.id}:backlog`,
      workspaceId,
      campaignId: plan.campaign.id,
      niche: plan.niche,
      provider: plan.provider,
      providerEngine: plan.providerEngine,
      seedId: plan.seed?.id ?? null,
      discoveryJobsClaimed: discovery?.jobsClaimed ?? 0,
      candidatesInserted: discovery?.rawCandidatesInserted ?? 0,
      providerRunsChecked: providerRuns?.runsChecked ?? 0,
      providerRunsIngested: providerRuns?.runsIngested ?? 0,
      processingJobsCompleted: processing.jobsCompleted,
      verificationJobsClaimed: verification.jobsClaimed,
      importsAllowed: false,
      autoSendEnabled: AUTO_SEND_ENABLED,
    });
    return NextResponse.json({
      ok: true,
      dryRun: false,
      ...base,
      discoveryJobId,
      discovery,
      providerRuns,
      processing,
      verification,
      candidateCount: discovery?.rawCandidatesInserted ?? 0,
      discoverySkippedReason: plan.providerAvailable ? null : "No discovery provider is available; scoped backlog processing and verification still ran.",
      providerSpendUsd,
    }, { headers: { "Cache-Control": "no-store" } });
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