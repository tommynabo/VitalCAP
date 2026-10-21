import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { UnauthorizedError, requireWorkspaceOwner } from "@/lib/auth/workspace";
import { getDb } from "@/infrastructure/neon/db";
import { getApifyRecoverySnapshot } from "@/infrastructure/neon/repositories/provider-runs";
import { getProductivityDiagnostics } from "@/infrastructure/neon/repositories/productivity-diagnostics";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";
import { getSystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import { getDeliveryEnv, getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { getDayBounds } from "@/lib/time/day-bounds";
import { AUTO_SEND_ENABLED } from "@/services/setter/autonomy-policy";
import { buildProviderHealthSnapshot } from "@/services/discovery/provider-health";
import { runAutopilotCronTick } from "@/infrastructure/jobs/runners/autopilot-runner";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";
import { enqueueVerificationJobs, runVerificationCronTick } from "@/infrastructure/jobs/runners/verification-runner";
import { runInstantlyImportTick } from "@/infrastructure/jobs/runners/instantly-import-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function readMapsState(workspaceId: string, now: Date) {
  const mapsEnv = getMapsEnv();
  const serperEnv = getSerperEnv();
  const [recovery, health] = await Promise.all([
    getApifyRecoverySnapshot(workspaceId, now),
    getSystemHealthDiagnostics({
      workspaceId,
      now,
      mapsDailyBudgetUsd: mapsEnv.APIFY_DAILY_COST_LIMIT_USD,
      serperDailyBudgetUsd: serperEnv.SERPER_DAILY_COST_LIMIT_USD,
    }),
  ]);
  const providerHealth = buildProviderHealthSnapshot({
    provider: "apify",
    configured: mapsEnv.MAPS_PROVIDER === "apify" && Boolean(mapsEnv.APIFY_API_TOKEN),
    budgetAllowed: health.providers.apify.budgetAllowed,
    usage: {
      calls: health.providers.apify.recentTerminalCalls,
      errors: health.providers.apify.recentErrors,
      items: 0,
      totalLatencyMs: 0,
      costUsd: 0,
      quotaRemaining: null,
    },
    recovery,
  });
  const pauseReason = recovery.safetyBlocked
    ? "manual_reconciliation_required"
    : recovery.recoveryProbeInFlight
      ? "recovery_probe_in_flight"
      : recovery.latestFailureKind
        ? `${recovery.latestFailureKind}_failure`
        : providerHealth.allocationHealth === "paused"
          ? "provider_health_paused"
          : null;

  return {
    pauseReason,
    allocation: providerHealth.allocationHealth,
    providerAvailable: providerHealth.providerAvailable,
    budgetAllowed: providerHealth.budgetAllowed,
    recoveryProbeEligible: recovery.recoveryProbeEligible,
    recoveryProbeInFlight: recovery.recoveryProbeInFlight,
    nextRecoveryAttemptAt: recovery.nextRecoveryAttemptAt?.toISOString() ?? null,
    latestFailureKind: recovery.latestFailureKind,
    latestFailureAt: recovery.latestFailureAt,
    latestSuccessAt: recovery.latestSuccessAt,
    recoveredAfterLatestFailure: providerHealth.recoveredAfterLatestFailure,
  };
}

async function readCycleMetrics(workspaceId: string, startedAt: Date, completedAt: Date) {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS raw_new,
      COUNT(*) FILTER (WHERE raw.processed)::int AS processed_new,
      COALESCE(SUM(COALESCE(NULLIF(raw.processing_metrics->>'websiteEmailsFound', '')::int, 0)), 0)::int AS email_new
    FROM raw_candidates raw
    JOIN campaigns campaign ON campaign.id = raw.campaign_id
    WHERE campaign.workspace_id = ${workspaceId}::uuid
      AND raw.discovered_at >= ${startedAt.toISOString()}::timestamptz
      AND raw.discovered_at <= ${completedAt.toISOString()}::timestamptz
  `);
  const row = result.rows[0] as { raw_new?: number; processed_new?: number; email_new?: number } | undefined;
  return {
    rawNew: Number(row?.raw_new ?? 0),
    processedNew: Number(row?.processed_new ?? 0),
    emailNew: Number(row?.email_new ?? 0),
  };
}

export async function POST() {
  try {
    const context = await requireWorkspaceOwner();
    const workspaceId = context.workspaceId;
    const startedAt = new Date();
    const before = await Promise.all([
      readMapsState(workspaceId, startedAt),
      getProductivityDiagnostics(workspaceId, startedAt),
      getProductionCapacityDiagnostics(workspaceId, startedAt),
    ]);

    const existingDrain = await runInstantlyImportTick({ processQueueOnly: true, reconcileEligible: true, now: startedAt });
    const autopilot = await runAutopilotCronTick(startedAt);
    const discovery = await runDiscoveryCronTick(1, startedAt);
    const providerRuns = await runProviderRunsCronTick(5);
    const processing = await runProcessingCronTick(4, startedAt, { timeBudgetMs: 60_000 });
    const createdSince = new Date(startedAt.getTime() - 48 * 60 * 60_000);
    const verificationEnqueued = await enqueueVerificationJobs({ createdSince });
    const verification = await runVerificationCronTick(10, { createdSince, skipInstantlyImport: true });
    const finalDrain = await runInstantlyImportTick({ processQueueOnly: true, reconcileEligible: true, now: new Date() });

    const completedAt = new Date();
    const [mapsAfter, productivityAfter, capacityAfter, cycleMetrics] = await Promise.all([
      readMapsState(workspaceId, completedAt),
      getProductivityDiagnostics(workspaceId, completedAt),
      getProductionCapacityDiagnostics(workspaceId, completedAt),
      readCycleMetrics(workspaceId, startedAt, completedAt),
    ]);
    const deliveryEnv = getDeliveryEnv();
    const dayBounds = getDayBounds(productivityAfter.timezone, completedAt);
    const importedToday = await getDb().execute(sql`
      SELECT COUNT(DISTINCT normalized_email)::int AS contacts
      FROM instantly_lead_imports
      WHERE workspace_id = ${workspaceId}::uuid
        AND provider_campaign_id = ${deliveryEnv.INSTANTLY_CAMPAIGN_ID}
        AND status = 'instantly_added'
        AND provider_lead_id IS NOT NULL
        AND uploaded_at >= ${dayBounds.start.toISOString()}::timestamptz
        AND uploaded_at < ${completedAt.toISOString()}::timestamptz
    `);
    const providerAccounting = providerRuns.ingestionAccounting;
    const returnedAccounted = Object.values(providerAccounting).reduce((total, value) => total + value, 0);

    return NextResponse.json({
      status: "completed",
      cycleCount: 1,
      discoveryRequested: autopilot.ordersScheduled,
      providerRunsChecked: providerRuns.runsChecked,
      providerItemsReturned: providerRuns.itemsReturned,
      insertedNewRaw: providerAccounting.INSERTED_NEW_RAW,
      duplicateExistingRaw: providerAccounting.DUPLICATE_EXISTING_RAW,
      invalidOrUnmappable: providerAccounting.INVALID_OR_UNMAPPABLE,
      failedInsert: providerAccounting.FAILED_INSERT,
      unknown: providerAccounting.UNKNOWN,
      returnedAccounted,
      returnedUnexplained: Math.max(0, providerRuns.itemsReturned - returnedAccounted),
      syncMappedCandidates: discovery.rawCandidatesProduced,
      rawNew: cycleMetrics.rawNew,
      rawDuplicate: discovery.rawCandidatesDuplicate + providerAccounting.DUPLICATE_EXISTING_RAW,
      processedNew: cycleMetrics.processedNew,
      emailNew: cycleMetrics.emailNew,
      verificationValidNew: verification.verificationValid ?? 0,
      eligibleNew: Math.max(0, productivityAfter.instantlyToday.eligibleAccounts - before[1].instantlyToday.eligibleAccounts),
      existingEligibleDrained: existingDrain.leadsAdded,
      instantlyNew: existingDrain.leadsAdded + finalDrain.leadsAdded,
      cumulativeInstantlyNewToday: Number((importedToday.rows[0] as { contacts?: number } | undefined)?.contacts ?? 0),
      importPending: finalDrain.leadsQueued,
      importFailed: finalDrain.leadsFailed,
      reconciliationRequired: finalDrain.leadsNeedsReconciliation ?? 0,
      instantlyCurrentContacts: capacityAfter.instantly.currentLeads,
      instantlyContactLimit: capacityAfter.instantly.effectiveContactHardLimit,
      instantlyAvailableSlots: capacityAfter.instantly.remainingLeads,
      monthlyEmailHeadroom: capacityAfter.instantly.currentMonthlySendHeadroom,
      mapsBefore: before[0],
      mapsAfter,
      verificationEnqueued,
      verificationCompleted: verification.emailsVerified,
      processingCompleted: processing.jobsCompleted,
      discoveryJobsClaimed: discovery.jobsClaimed,
      providerRunWarnings: providerRuns.warnings.length,
      autoSendEnabled: AUTO_SEND_ENABLED,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    }
    return NextResponse.json({ status: "failed" }, { status: 500 });
  }
}