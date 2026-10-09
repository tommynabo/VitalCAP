import { and, desc, eq, sql, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { discoveryJobs, processingJobs, rawCandidates } from "../schema/discovery";
import { outreachQueue, outreachEvents, deadLetterJobs, instantlyLeadImports, instantlyImportLocks } from "../schema/outreach";
import { campaignMemberships, campaigns } from "../schema/campaigns";
import { contactPoints } from "../schema/contacts";
import { campaignProviderMappings, complianceDecisions, verificationJobs } from "../schema/compliance";
import { conversations } from "../schema/conversations";
import { autopilotSettings } from "../schema/autopilot";
import { providerRuns } from "../schema/providers";
import { cronRuns } from "../schema/jobs-meta";
import { getMapsEnv, getSerperEnv, getVerificationEnv, getDeliveryEnv, getIntelligenceEnv } from "@/lib/config/env";
import { ACTUAL_PRIOR_COLD_OUTREACH_STATES } from "@/services/deduplication/outreach-dedup";
import type { ProviderUsageStats } from "@/domain/providers/types";
import type { EngineType } from "@/domain/campaigns/types";

export type ProviderRowStatus = "connected" | "degraded" | "paused" | "missing_configuration" | "unknown";

export interface InstantlyPipelineDiagnostics {
  rawCandidates: number;
  processedCandidates: number;
  membershipStages: Record<string, number>;
  emailVerification: Record<string, number>;
  emailEligibility: Record<string, number>;
  verificationJobs: Record<string, number>;
  importStatuses: Record<string, number>;
  actualOutreach: number;
  scheduledDryRun: number;
  instantlySent: number;
  setterSendUnknown: number;
  campaignMappingCount: number;
  circuitOpen: boolean;
  lastSuccessfulLeadWriteAt: string | null;
  lastSuccessfulLeadWriteCampaignId: string | null;
}

export async function getInstantlyPipelineDiagnostics(
  workspaceId: string,
  providerCampaignId: string,
): Promise<InstantlyPipelineDiagnostics> {
  const db = getDb();
  const actualOutreachStates = sql.raw(ACTUAL_PRIOR_COLD_OUTREACH_STATES.map((state) => `'${state}'`).join(", "));
  const scopedAutopilotCampaign = and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.autopilotEnabled, true));
  const [candidateCounts, stages, emailCounts, verificationCounts, imports, outreach, setterUnknown, mappings, circuit, lastSuccessfulLeadWrite] = await Promise.all([
    db.select({
      total: sql<number>`count(*)`,
      processed: sql<number>`count(*) filter (where ${rawCandidates.processed} = true)`,
    }).from(rawCandidates).innerJoin(campaigns, eq(rawCandidates.campaignId, campaigns.id)).where(scopedAutopilotCampaign),
    db.select({ stage: campaignMemberships.stage, count: sql<number>`count(*)` })
      .from(campaignMemberships).innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
      .where(scopedAutopilotCampaign).groupBy(campaignMemberships.stage),
    db.select({
      verificationStatus: contactPoints.verificationStatus,
      channelEligibility: contactPoints.channelEligibility,
      count: sql<number>`count(distinct ${contactPoints.id})`,
    }).from(contactPoints)
      .innerJoin(campaignMemberships, eq(campaignMemberships.accountId, contactPoints.accountId))
      .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
      .where(and(scopedAutopilotCampaign, eq(contactPoints.type, "email")))
      .groupBy(contactPoints.verificationStatus, contactPoints.channelEligibility),
    db.select({ status: verificationJobs.status, count: sql<number>`count(*)` })
      .from(verificationJobs).where(eq(verificationJobs.workspaceId, workspaceId)).groupBy(verificationJobs.status),
    db.select({ status: instantlyLeadImports.status, count: sql<number>`count(*)` })
      .from(instantlyLeadImports)
      .innerJoin(campaigns, eq(instantlyLeadImports.sourceCampaignId, campaigns.id))
      .where(and(eq(instantlyLeadImports.providerCampaignId, providerCampaignId), scopedAutopilotCampaign))
      .groupBy(instantlyLeadImports.status),
    db.select({
      actual: sql<number>`count(*) filter (where
        (${outreachQueue.deliveryMode} = 'live' and ${outreachQueue.state} in (${actualOutreachStates}))
        or exists (
          select 1 from outreach_events oe
          where oe.outreach_queue_item_id = ${outreachQueue.id}
            and oe.state in (${actualOutreachStates})
        )
      )`,
      dryRunScheduled: sql<number>`count(*) filter (where ${outreachQueue.deliveryMode} = 'dry_run' and ${outreachQueue.state} = 'scheduled')`,
      instantlySent: sql<number>`count(*) filter (where ${outreachQueue.deliveryMode} = 'live' and ${outreachQueue.payload}->>'provider' = 'instantly' and ${outreachQueue.state} = 'sent')`,
    }).from(outreachQueue).innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id)).where(scopedAutopilotCampaign),
    db.select({ count: sql<number>`count(*)` }).from(conversations).innerJoin(campaigns, eq(conversations.campaignId, campaigns.id))
      .where(and(scopedAutopilotCampaign, eq(conversations.state, "send_unknown"))),
    db.select({ count: sql<number>`count(*)` }).from(campaignProviderMappings).innerJoin(campaigns, eq(campaignProviderMappings.campaignId, campaigns.id))
      .where(and(scopedAutopilotCampaign, eq(campaignProviderMappings.provider, "instantly"), eq(campaignProviderMappings.providerCampaignId, providerCampaignId), eq(campaignProviderMappings.enabled, true))),
    db.select({ count: sql<number>`count(*)` }).from(instantlyImportLocks)
      .where(and(eq(instantlyImportLocks.providerCampaignId, providerCampaignId), sql`${instantlyImportLocks.lockToken} LIKE 'auth-failure:%'`)),
    db.select({ uploadedAt: instantlyLeadImports.uploadedAt, providerCampaignId: instantlyLeadImports.providerCampaignId })
      .from(instantlyLeadImports)
      .innerJoin(campaigns, eq(instantlyLeadImports.sourceCampaignId, campaigns.id))
      .where(and(
        eq(instantlyLeadImports.providerCampaignId, providerCampaignId),
        scopedAutopilotCampaign,
        eq(instantlyLeadImports.status, "instantly_added"),
        isNotNull(instantlyLeadImports.uploadedAt),
        isNotNull(instantlyLeadImports.providerLeadId),
        sql`${instantlyLeadImports.providerLeadId} NOT LIKE 'dryrun%'`,
      ))
      .orderBy(desc(instantlyLeadImports.uploadedAt))
      .limit(1),
  ]);

  const emailVerification: Record<string, number> = {};
  const emailEligibility: Record<string, number> = {};
  for (const row of emailCounts) {
    emailVerification[row.verificationStatus] = (emailVerification[row.verificationStatus] ?? 0) + Number(row.count);
    emailEligibility[row.channelEligibility] = (emailEligibility[row.channelEligibility] ?? 0) + Number(row.count);
  }
  return {
    rawCandidates: Number(candidateCounts[0]?.total ?? 0),
    processedCandidates: Number(candidateCounts[0]?.processed ?? 0),
    membershipStages: Object.fromEntries(stages.map((row) => [row.stage, Number(row.count)])),
    emailVerification,
    emailEligibility,
    verificationJobs: Object.fromEntries(verificationCounts.map((row) => [row.status, Number(row.count)])),
    importStatuses: Object.fromEntries(imports.map((row) => [row.status, Number(row.count)])),
    actualOutreach: Number(outreach[0]?.actual ?? 0),
    scheduledDryRun: Number(outreach[0]?.dryRunScheduled ?? 0),
    instantlySent: Number(outreach[0]?.instantlySent ?? 0),
    setterSendUnknown: Number(setterUnknown[0]?.count ?? 0),
    campaignMappingCount: Number(mappings[0]?.count ?? 0),
    circuitOpen: Number(circuit[0]?.count ?? 0) > 0,
    lastSuccessfulLeadWriteAt: lastSuccessfulLeadWrite[0]?.uploadedAt?.toISOString() ?? null,
    lastSuccessfulLeadWriteCampaignId: lastSuccessfulLeadWrite[0]?.providerCampaignId ?? null,
  };
}

export async function getActiveAutopilotDiscoveryEngineTypes(): Promise<EngineType[]> {
  const db = getDb();
  const rows = await db
    .select({ engineType: campaigns.engineType })
    .from(campaigns)
    .innerJoin(autopilotSettings, eq(autopilotSettings.workspaceId, campaigns.workspaceId))
    .where(and(
      eq(campaigns.status, "active"),
      eq(campaigns.autopilotEnabled, true),
      eq(autopilotSettings.enabled, true),
      eq(autopilotSettings.emergencyStopped, false),
      eq(autopilotSettings.systemPaused, false),
    ));
  return rows.map((row) => row.engineType as EngineType);
}

/**
 * Configuration-derived status only (Prompt 7 §26: never claim "connected"
 * solely because a key exists is respected in the other direction too —
 * this never claims connected when a key is *missing*). Real health-check
 * probing (actually calling each provider) lands with the Gate D adapters;
 * until then, "missing_configuration" is the only status this function
 * asserts with confidence, everything else is reported as "unknown".
 */
export function getProviderRows(): Array<{ name: string; status: ProviderRowStatus; detail: string }> {
  const mapsEnv = getMapsEnv();
  const serperEnv = getSerperEnv();
  const verifyEnv = getVerificationEnv();
  const deliveryEnv = getDeliveryEnv();
  const intelEnv = getIntelligenceEnv();
  const rows: Array<{ name: string; status: ProviderRowStatus; detail: string }> = [];

  rows.push(
    deliveryEnv.EMAIL_DELIVERY_PROVIDER === "instantly" && deliveryEnv.INSTANTLY_API_KEY
      ? { name: "Email delivery (Instantly)", status: "unknown", detail: "Configured — health not yet probed" }
      : { name: "Email delivery (Instantly)", status: "missing_configuration", detail: "INSTANTLY_API_KEY not set" },
  );
  rows.push(
    deliveryEnv.INSTANTLY_API_KEY
      ? { name: "Instantly campaign imports", status: "unknown", detail: `Configured for campaign ${deliveryEnv.INSTANTLY_CAMPAIGN_ID}` }
      : { name: "Instantly campaign imports", status: "missing_configuration", detail: "INSTANTLY_API_KEY not set" },
  );
  rows.push({ name: "SMS delivery", status: "paused", detail: "SMS is disabled by product policy" });
  rows.push(
    verifyEnv.EMAIL_VERIFICATION_PROVIDER === "millionverifier" && (verifyEnv.MILLION_VERIFIER || verifyEnv.MILLIONVERIFIER_API_KEY)
      ? { name: "Email verification", status: "unknown", detail: "Configured — health not yet probed" }
      : { name: "Email verification", status: "missing_configuration", detail: "MILLION_VERIFIER not set" },
  );
  rows.push(
    mapsEnv.MAPS_PROVIDER === "apify" && mapsEnv.APIFY_API_TOKEN
      ? { name: "Maps discovery", status: "unknown", detail: "Configured — health not yet probed" }
      : { name: "Maps discovery", status: "missing_configuration", detail: "APIFY_API_TOKEN not set" },
  );
  rows.push(
    serperEnv.SERP_PROVIDER === "serper" && serperEnv.SERPER_API_KEY
      ? { name: "Google SERP / LinkedIn owner", status: "unknown", detail: "Configured — health not yet probed" }
      : { name: "Google SERP / LinkedIn owner", status: "missing_configuration", detail: "SERPER_API_KEY not set" },
  );
  rows.push(
    intelEnv.LLM_PROVIDER === "openai" && intelEnv.LLM_PROVIDER_API_KEY
      ? { name: "LLM (setter drafts)", status: "unknown", detail: "Configured — health not yet probed" }
      : { name: "LLM (setter drafts)", status: "missing_configuration", detail: "LLM_PROVIDER_API_KEY not set" },
  );
  rows.push(
    deliveryEnv.INSTANTLY_WEBHOOK_SECRET
      ? { name: "Outreach webhooks", status: "unknown", detail: "Signature secret configured" }
      : { name: "Outreach webhooks", status: "missing_configuration", detail: "INSTANTLY_WEBHOOK_SECRET not set" },
  );

  return rows;
}

function toFiniteUsageNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : 0;
  } catch {
    return 0;
  }
}

export async function getEmailVerificationUsage(workspaceId: string): Promise<ProviderUsageStats> {
  const db = getDb();
  const [row] = await db
    .select({
      calls: sql<number>`coalesce(sum(coalesce((${providerRuns.metadata} ->> 'calls')::int, ${providerRuns.itemsRequested})), 0)`,
      items: sql<number>`coalesce(sum(coalesce((${providerRuns.metadata} ->> 'items')::int, ${providerRuns.itemsReturned})), 0)`,
      errors: sql<number>`coalesce(sum(coalesce((${providerRuns.metadata} ->> 'errors')::int, 0)), 0)`,
      totalLatencyMs: sql<number>`coalesce(sum(coalesce((${providerRuns.metadata} ->> 'totalLatencyMs')::int, 0)), 0)`,
      costUsd: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)`,
    })
    .from(providerRuns)
    .where(and(eq(providerRuns.workspaceId, workspaceId), eq(providerRuns.provider, "email_verification")));

  return {
    calls: toFiniteUsageNumber(row?.calls),
    items: toFiniteUsageNumber(row?.items),
    errors: toFiniteUsageNumber(row?.errors),
    totalLatencyMs: toFiniteUsageNumber(row?.totalLatencyMs),
    costUsd: toFiniteUsageNumber(row?.costUsd),
    quotaRemaining: null,
  };
}

export interface EmailVerificationMetrics {
  unverified: number;
  valid: number;
  catchAll: number;
  risky: number;
  invalid: number;
  blocked: number;
  ready: number;
}

export async function getEmailVerificationMetrics(workspaceId: string): Promise<EmailVerificationMetrics> {
  const db = getDb();
  const [contactCounts, readyCount] = await Promise.all([
    db.select({
      unverified: sql<number>`count(*) filter (where ${contactPoints.type} = 'email' and ${contactPoints.verificationStatus} in ('unverified', 'unknown'))`,
      valid: sql<number>`count(*) filter (where ${contactPoints.type} = 'email' and ${contactPoints.verificationStatus} = 'valid')`,
      catchAll: sql<number>`count(*) filter (where ${contactPoints.type} = 'email' and ${contactPoints.verificationStatus} = 'catch_all')`,
      risky: sql<number>`count(*) filter (where ${contactPoints.type} = 'email' and ${contactPoints.verificationStatus} = 'risky')`,
      invalid: sql<number>`count(*) filter (where ${contactPoints.type} = 'email' and ${contactPoints.verificationStatus} in ('invalid', 'disposable', 'bounced'))`,
      blocked: sql<number>`count(distinct ${contactPoints.id}) filter (where ${contactPoints.type} = 'email' and (${contactPoints.verificationStatus} in ('invalid', 'disposable', 'bounced') or ${contactPoints.channelEligibility} in ('opted_out', 'blocked') or ${complianceDecisions.decision} = 'blocked'))`,
    }).from(contactPoints)
      .leftJoin(complianceDecisions, and(
        eq(complianceDecisions.contactPointId, contactPoints.id),
        sql`superseded_at IS NULL`,
      ))
      .where(eq(contactPoints.workspaceId, workspaceId)),
    db.select({ count: sql<number>`count(distinct ${campaignMemberships.accountId})` })
      .from(campaignMemberships)
      .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaignMemberships.stage, "ready"))),
  ]);

  return {
    unverified: contactCounts[0]?.unverified ?? 0,
    valid: contactCounts[0]?.valid ?? 0,
    catchAll: contactCounts[0]?.catchAll ?? 0,
    risky: contactCounts[0]?.risky ?? 0,
    invalid: contactCounts[0]?.invalid ?? 0,
    blocked: contactCounts[0]?.blocked ?? 0,
    ready: readyCount[0]?.count ?? 0,
  };
}

export interface QueueHealthSnapshot {
  pendingCount: number;
  processingCount: number;
  deadLetterCount: number;
  oldestPendingAgeMs: number;
  stuckProcessingCount: number;
  healthy: boolean;
}

const STUCK_PROCESSING_THRESHOLD_MS = 15 * 60 * 1000;

export async function getQueueHealth(workspaceId: string): Promise<QueueHealthSnapshot> {
  const db = getDb();
  const stuckBefore = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS);

  const [discoveryCounts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${discoveryJobs.status} = 'pending')`,
      processing: sql<number>`count(*) filter (where ${discoveryJobs.status} = 'processing')`,
      stuck: sql<number>`count(*) filter (where ${discoveryJobs.status} = 'processing' and ${discoveryJobs.lockedAt} < ${stuckBefore})`,
      oldestPending: sql<Date | null>`min(${discoveryJobs.createdAt}) filter (where ${discoveryJobs.status} = 'pending')`,
    })
    .from(discoveryJobs)
    .innerJoin(campaigns, eq(discoveryJobs.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));

  const [processingCounts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${processingJobs.status} = 'pending')`,
      processing: sql<number>`count(*) filter (where ${processingJobs.status} = 'processing')`,
      stuck: sql<number>`count(*) filter (where ${processingJobs.status} = 'processing' and ${processingJobs.lockedAt} < ${stuckBefore})`,
      oldestPending: sql<Date | null>`min(${processingJobs.createdAt}) filter (where ${processingJobs.status} = 'pending')`,
    })
    .from(processingJobs)
    .innerJoin(campaigns, eq(processingJobs.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));

  const [outreachCounts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outreachQueue.status} = 'pending')`,
      processing: sql<number>`count(*) filter (where ${outreachQueue.status} = 'processing')`,
      stuck: sql<number>`count(*) filter (where ${outreachQueue.status} = 'processing' and ${outreachQueue.lockedAt} < ${stuckBefore})`,
      oldestPending: sql<Date | null>`min(${outreachQueue.createdAt}) filter (where ${outreachQueue.status} = 'pending')`,
    })
    .from(outreachQueue)
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));

  const [deadLetterRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(deadLetterJobs)
    .innerJoin(campaigns, eq(deadLetterJobs.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));

  const oldestTimestamps = [discoveryCounts?.oldestPending, processingCounts?.oldestPending, outreachCounts?.oldestPending]
    .filter((value): value is Date => value != null)
    .map((value) => new Date(value).getTime());

  const pendingCount = (discoveryCounts?.pending ?? 0) + (processingCounts?.pending ?? 0) + (outreachCounts?.pending ?? 0);
  const processingCount =
    (discoveryCounts?.processing ?? 0) + (processingCounts?.processing ?? 0) + (outreachCounts?.processing ?? 0);
  const stuckProcessingCount = (discoveryCounts?.stuck ?? 0) + (processingCounts?.stuck ?? 0) + (outreachCounts?.stuck ?? 0);
  const deadLetterCount = deadLetterRow?.total ?? 0;
  const oldestPendingAgeMs = oldestTimestamps.length > 0 ? Date.now() - Math.min(...oldestTimestamps) : 0;

  return {
    pendingCount,
    processingCount,
    deadLetterCount,
    oldestPendingAgeMs,
    stuckProcessingCount,
    healthy: stuckProcessingCount === 0 && deadLetterCount === 0,
  };
}

export interface DeadLetterSample {
  id: string;
  jobType: string;
  reason: string;
  failedAt: string;
}

export async function getDeadLetterSamples(workspaceId: string): Promise<DeadLetterSample[]> {
  const db = getDb();
  const rows = await db
    .select({ job: deadLetterJobs })
    .from(deadLetterJobs)
    .innerJoin(campaigns, eq(deadLetterJobs.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(sql`${deadLetterJobs.createdAt} desc`)
    .limit(20);

  return rows.map(({ job }) => ({
    id: job.id,
    jobType: job.sourceTable,
    reason: job.lastError,
    failedAt: job.createdAt.toISOString(),
  }));
}

export async function getCronLastRunAt(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ latest: sql<Date | null>`max(${providerRuns.startedAt})` })
    .from(providerRuns)
    .where(eq(providerRuns.workspaceId, workspaceId));
  return row?.latest ? new Date(row.latest).toISOString() : null;
}

export async function getLastCronRouteRunAt(route: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ finishedAt: cronRuns.finishedAt })
    .from(cronRuns)
    .where(and(eq(cronRuns.route, route), eq(cronRuns.status, "completed")))
    .orderBy(desc(cronRuns.finishedAt))
    .limit(1);
  return row?.finishedAt?.toISOString() ?? null;
}

export async function getWebhookLastEventAt(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ latest: sql<Date | null>`max(${outreachEvents.occurredAt})` })
    .from(outreachEvents)
    .innerJoin(outreachQueue, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(and(eq(campaigns.workspaceId, workspaceId), isNotNull(outreachEvents.providerEventId)));
  return row?.latest ? new Date(row.latest).toISOString() : null;
}

export async function getDbConnectivityOk(): Promise<boolean> {
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
