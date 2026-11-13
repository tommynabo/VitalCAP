import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UnauthorizedError, requireWorkspaceAdmin } from "@/lib/auth/workspace";
import { restoreNormalOperation, startIsolatedPilot, getPilotControlState, acquirePilotRunPermit } from "@/infrastructure/neon/repositories/pilot-control";
import { listAutopilotEnabledCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { getAutopilotPacingState, getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getApifyRecoverySnapshot } from "@/infrastructure/neon/repositories/provider-runs";
import { enqueueDiscoveryOrdersWithinDailyRawCap } from "@/infrastructure/neon/repositories/daily-raw-request-cap";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";
import { createApifyCredentialFingerprint } from "@/services/discovery/provider-health";
import { MAX_APIFY_RECOVERY_PROBE_RAW, planApifyRecoveryProbe } from "@/services/autopilot/target-planner";
import { getMapsEnv } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), confirmation: z.literal("ENABLE_ISOLATED_FOUR_NICHE_PILOT") }).strict(),
  z.object({ action: z.literal("recovery"), campaignId: z.uuid(), confirmation: z.literal("RUN_ONE_APIFY_RECOVERY_PROBE") }).strict(),
  z.object({ action: z.literal("restore"), confirmation: z.literal("RESTORE_NORMAL_AUTOMATION") }).strict(),
]);

async function runRecoveryProbe(input: { workspaceId: string; actorUserId: string; campaignId: string }) {
  const [pilot, settings, pacing, recovery, campaigns] = await Promise.all([
    getPilotControlState(),
    getAutopilotSettings(input.workspaceId),
    getAutopilotPacingState(input.workspaceId),
    getApifyRecoverySnapshot(input.workspaceId),
    listAutopilotEnabledCampaigns(input.workspaceId),
  ]);
  if (pilot.status !== "active" || pilot.workspaceId !== input.workspaceId || !pilot.sessionId || settings.emergencyStopped) {
    throw new Error("Pilot recovery blocked: active session and clear emergency stop are required.");
  }
  const mapsEnv = getMapsEnv();
  const credentialFingerprint = createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN);
  if (!credentialFingerprint || mapsEnv.MAPS_PROVIDER !== "apify") {
    throw new Error("Pilot recovery blocked: Apify credentials and provider selection are required.");
  }
  const campaign = campaigns.find((candidate) => candidate.id === input.campaignId);
  if (!campaign || (campaign.engineType !== "maps_fast" && campaign.engineType !== "maps_deep")) {
    throw new Error("Pilot recovery blocked: campaign must be an existing active Maps campaign with Autopilot enabled.");
  }
  const now = new Date();
  const order = planApifyRecoveryProbe({
    workspaceId: input.workspaceId,
    campaigns: [campaign],
    rawNeeded: Math.min(MAX_APIFY_RECOVERY_PROBE_RAW, pacing.rawRequestsRemaining),
    eligible: recovery.recoveryProbeEligible && !recovery.safetyBlocked,
    dailyBudgetAllowed: pacing.apifyDailyBudgetRemaining > 0,
    cooldownAt: recovery.nextRecoveryAttemptAt,
    credentialFingerprint,
    failureEpoch: recovery.latestFailureAt ? new Date(recovery.latestFailureAt).toISOString() : recovery.nextRecoveryAttemptAt?.toISOString() ?? "unknown",
    recoveryGeneration: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_URL ?? "local",
    now,
    timeZone: settings.timezone,
  })[0];
  if (!order) throw new Error("Pilot recovery blocked: existing Apify health, cooldown, budget, or raw-cap policy is not eligible.");

  const jobId = randomUUID();
  const permit = {
    runKey: "recovery",
    runType: "recovery" as const,
    sessionId: pilot.sessionId,
    workspaceId: input.workspaceId,
    campaignId: order.campaignId,
    discoveryJobId: jobId,
    actorUserId: input.actorUserId,
  };
  if (!await acquirePilotRunPermit(permit)) {
    throw new Error("Pilot recovery blocked: the single recovery permit is already reserved.");
  }
  const reservation = await enqueueDiscoveryOrdersWithinDailyRawCap([{
    id: jobId,
    campaignId: order.campaignId,
    type: "run_engine_batch",
    payload: {
      engineType: order.engineType,
      desiredRawCount: order.desiredRawCount,
      planningWindow: order.planningWindow,
      reason: order.reason,
      origin: "recovery_probe",
      recoveryCredentialFingerprint: credentialFingerprint,
      pilotSessionId: pilot.sessionId,
      pilotRunKey: "recovery",
    },
    idempotencyKey: order.idempotencyKey,
    desiredRawCount: order.desiredRawCount,
    maxAttempts: 1,
  }], now);
  const job = reservation.orders[0];
  if (!job) throw new Error("Pilot recovery blocked: the recovery order was not reserved by the daily raw cap.");
  const discovery = await runDiscoveryCronTick(1, now, {
    campaignId: order.campaignId,
    jobId: job.id,
    allowScopedDraftCampaign: true,
    pilotSessionId: pilot.sessionId,
    pilotRunKey: "recovery",
  });
  const providerRuns = discovery.providerRunsStarted > 0
    ? await runProviderRunsCronTick(1, {
      campaignId: order.campaignId,
      discoveryJobId: job.id,
      pilotSessionId: pilot.sessionId,
      pilotRunKey: "recovery",
      workspaceId: input.workspaceId,
    })
    : null;
  return { jobId: job.id, campaignId: order.campaignId, desiredRawCount: job.desiredRawCount, discovery, providerRuns };
}

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const context = await requireWorkspaceAdmin();
    if (body.action === "recovery") {
      const result = await runRecoveryProbe({ workspaceId: context.workspaceId, actorUserId: context.user.userId, campaignId: body.campaignId });
      return NextResponse.json({ recovery: result }, { headers: { "Cache-Control": "no-store" } });
    }
    const state = body.action === "enable"
      ? await startIsolatedPilot({ workspaceId: context.workspaceId, actorUserId: context.user.userId })
      : await restoreNormalOperation({ workspaceId: context.workspaceId, actorUserId: context.user.userId });
    return NextResponse.json({ pilot: state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid pilot control command." }, { status: 400 });
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace admin authorization required." }, { status: 403 });
    if (error instanceof Error && (error.message.includes("Pilot enable blocked") || error.message.includes("Pilot restore blocked") || error.message.includes("Pilot recovery blocked"))) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Pilot control failed; automation remains fail-closed." }, { status: 500 });
  }
}