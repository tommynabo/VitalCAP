import { and, eq, gte, count, sql } from "drizzle-orm";
import { getDb } from "../db";
import { campaigns, campaignMemberships } from "../schema/campaigns";
import { accounts } from "../schema/accounts";
import { discoveryJobs, processingJobs, searchSeeds } from "../schema/discovery";
import { outreachQueue, outreachEvents } from "../schema/outreach";
import { conversations, meetings } from "../schema/conversations";
import { autopilotSettings, rebalanceDecisions } from "../schema/autopilot";
import { auditLog } from "../schema/audit";
import type { EngineType } from "@/domain/campaigns/types";
import type { AutopilotSettings, EngineTargetState, GlobalAutopilotState, ProviderHealthStatus, RebalanceDecision } from "@/domain/autopilot/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { getAutopilotPacingMetrics } from "./autopilot-pacing";
import { getRecentProviderUsage } from "./provider-runs";
import { getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { computeAutopilotPacing } from "@/services/autopilot/pacing-service";

const DEFAULT_AUTOPILOT_SETTINGS = {
  enabled: false,
  emergencyStopped: false,
  systemPaused: false,
  globalDailyTarget: 25,
  targetMetric: "qualified",
  timezone: "Europe/Madrid",
  operatingStartHour: null,
  operatingEndHour: null,
  maxDailyApifySpendUsd: null,
} as const;

function toAutopilotSettings(row: typeof autopilotSettings.$inferSelect): AutopilotSettings {
  return {
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    emergencyStopped: row.emergencyStopped,
    systemPaused: row.systemPaused,
    systemPauseReason: row.systemPauseReason,
    systemPausedAt: row.systemPausedAt?.toISOString() ?? null,
    globalDailyTarget: row.globalDailyTarget,
    targetMetric: row.targetMetric as AutopilotSettings["targetMetric"],
    timezone: row.timezone,
    operatingStartHour: row.operatingStartHour,
    operatingEndHour: row.operatingEndHour,
    maxDailyApifySpendUsd: row.maxDailyApifySpendUsd,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lazily bootstraps a workspace in the safe PAUSED state. */
export async function getAutopilotSettings(workspaceId: string): Promise<AutopilotSettings> {
  const db = getDb();
  await db.insert(autopilotSettings).values({ workspaceId, ...DEFAULT_AUTOPILOT_SETTINGS }).onConflictDoNothing({ target: autopilotSettings.workspaceId });
  const [row] = await db.select().from(autopilotSettings).where(eq(autopilotSettings.workspaceId, workspaceId));
  if (!row) throw new Error("Failed to initialize Autopilot settings.");
  return toAutopilotSettings(row);
}

export async function updateAutopilotSettingsWithAudit(input: {
  workspaceId: string;
  patch: Partial<Pick<AutopilotSettings, "enabled" | "emergencyStopped" | "globalDailyTarget">>;
  audit: { actorUserId: string | null; action: string; metadata: Record<string, unknown> };
}): Promise<AutopilotSettings> {
  const db = getDb();
  // `execute(sql)` returns PostgreSQL's snake_case keys, while the mapper below
  // deliberately consumes Drizzle's camelCase row type. Keep both writes in
  // the repository and use `.returning()` so this boundary stays type-safe.
  await getAutopilotSettings(input.workspaceId);
  const [updated] = await db
    .update(autopilotSettings)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(eq(autopilotSettings.workspaceId, input.workspaceId))
    .returning();
  if (!updated) throw new Error("Failed to update Autopilot settings.");

  await db.insert(auditLog).values({
    workspaceId: input.workspaceId,
    actorUserId: input.audit.actorUserId,
    action: input.audit.action,
    entityType: "autopilot_settings",
    entityId: input.workspaceId,
    metadata: input.audit.metadata,
  });
  return toAutopilotSettings(updated);
}

export async function updateAutopilotSettings(
  workspaceId: string,
  patch: Partial<Pick<AutopilotSettings, "enabled" | "emergencyStopped" | "globalDailyTarget">>,
): Promise<AutopilotSettings> {
  const db = getDb();
  await getAutopilotSettings(workspaceId);
  const [updated] = await db.update(autopilotSettings).set({ ...patch, updatedAt: new Date() }).where(eq(autopilotSettings.workspaceId, workspaceId)).returning();
  if (!updated) throw new Error("Failed to update Autopilot settings.");
  return toAutopilotSettings(updated);
}

const ENGINE_TYPES: EngineType[] = ["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"];

async function getEngineProviderHealth(workspaceId: string, engineType: EngineType): Promise<ProviderHealthStatus> {
  const mapsEnv = getMapsEnv();
  const serpEnv = getSerperEnv();
  const maps = mapsEnv.MAPS_PROVIDER === "apify" && Boolean(mapsEnv.APIFY_API_TOKEN)
    ? evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "apify"))
    : "paused";
  const serp = serpEnv.SERP_PROVIDER === "serper" && Boolean(serpEnv.SERPER_API_KEY)
    ? evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "serper"))
    : "paused";
  if (engineType === "maps_fast") return maps;
  if (engineType === "google_serp" || engineType === "linkedin_owner") return serp;
  if (engineType === "maps_deep") {
    if (maps === "paused" || serp === "paused") return "paused";
    if (maps === "degraded" || serp === "degraded") return "degraded";
    return maps === "untested" || serp === "untested" ? "untested" : "healthy";
  }
  // Hybrid Fill has no provider of its own: expose its actual routing
  // capacity instead of the misleading historical `unknown` state.
  if (maps === "healthy" || serp === "healthy" || maps === "untested" || serp === "untested") return "healthy";
  return maps === "degraded" || serp === "degraded" ? "degraded" : "paused";
}

export async function getAutopilotPacingState(workspaceId: string, now = new Date()) {
  const settings = await getAutopilotSettings(workspaceId);
  const metrics = await getAutopilotPacingMetrics(workspaceId, settings.timezone, now);
  const providerHealth = evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "apify"));
  const serpHealth = evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "serper"));
  const estimatedYield = metrics.historicalRawSampleSize >= 20
    ? Math.min(1, Math.max(0.1, metrics.historicalQualifiedCount / metrics.historicalRawSampleSize))
    : 0.25;
  const env = getMapsEnv();
  const effectiveBudget = Math.min(env.APIFY_DAILY_COST_LIMIT_USD, settings.maxDailyApifySpendUsd ?? Number.POSITIVE_INFINITY);
  const serpEnv = getSerperEnv();
  const apifyAvailable = Boolean(env.APIFY_API_TOKEN) && providerHealth !== "paused" && Math.max(0, effectiveBudget - metrics.apifySpendToday) > 0;
  const serperAvailable = Boolean(serpEnv.SERPER_API_KEY) && serpHealth !== "paused";
  return computeAutopilotPacing({
    workspaceId,
    timeZone: settings.timezone,
    dailyTarget: settings.globalDailyTarget,
    targetAchievedToday: metrics.qualifiedToday,
    rawRequestedToday: metrics.rawRequestedToday, rawReturnedToday: metrics.rawReturnedToday,
    processingInFlight: metrics.processingInFlight,
    providerRunsInFlight: metrics.providerRunsInFlight,
    expectedQualifiedFromInFlight: (metrics.providerRawItemsInFlight + metrics.processingInFlight) * estimatedYield,
    apifySpendToday: metrics.apifySpendToday,
    apifyDailyBudgetRemaining: Math.max(0, effectiveBudget - metrics.apifySpendToday),
    providerHealth,
    availableDiscoveryCapacity: apifyAvailable || serperAvailable,
    estimatedYield,
    yieldSampleSize: metrics.historicalRawSampleSize,
    now,
    operatingStartHour: settings.operatingStartHour,
    operatingEndHour: settings.operatingEndHour,
    maxDailyRawRequests: (await import("@/lib/config/env")).getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS,
  });
}

function startOfToday(timeZone: string): Date {
  return getDayBounds(timeZone).start;
}

/**
 * Real-data aggregation. This deliberately does not reuse
 * `src/services/autopilot/*` (those pure services compute rebalancing
 * decisions for the cron job, not read-only dashboard aggregates). Each
 * figure is a genuine count/sum against Neon — no fabricated values —
 * documented here as an intentional simplification versus a hypothetical
 * fully-modeled analytics warehouse.
 */
export async function getGlobalAutopilotState(workspaceId: string): Promise<GlobalAutopilotState> {
  const db = getDb();
  const settings = await getAutopilotSettings(workspaceId);
  const today = startOfToday(settings.timezone);

  const [qualifiedRow] = await db
    .select({ total: sql<number>`count(distinct ${campaignMemberships.accountId})` })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(eq(campaigns.workspaceId, workspaceId), gte(campaignMemberships.qualifiedAt, today)),
    );

  const [analyzedQualifiedRow] = await db
    .select({ total: sql<number>`count(distinct ${campaignMemberships.accountId})` })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        sql`${campaignMemberships.stage} IN ('qualified', 'ready')`,
        sql`EXISTS (
          SELECT 1 FROM prospect_analyses pa
          WHERE pa.campaign_id = ${campaignMemberships.campaignId}
            AND pa.account_id = ${campaignMemberships.accountId}
            AND pa.status = 'completed'
            AND pa.qualified = true
            AND pa.completed_at >= ${today.toISOString()}::timestamptz
            AND pa.id = (
              SELECT id FROM prospect_analyses pa2
              WHERE pa2.campaign_id = ${campaignMemberships.campaignId}
                AND pa2.account_id = ${campaignMemberships.accountId}
              ORDER BY created_at DESC LIMIT 1
            )
        )`
      )
    );

  const [outreachReadyRow] = await db
    .select({ total: sql<number>`count(distinct ${campaignMemberships.accountId})` })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    // We join on compliance decisions via sql trick to avoid importing it here if it gets cyclical, but let's import it.
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM autopilot_settings aps
          WHERE aps.workspace_id = ${workspaceId}
            AND aps.emergency_stopped = true
        )`,
        sql`EXISTS (
          SELECT 1 FROM contact_points cp
          JOIN compliance_decisions cd ON cd.contact_point_id = cp.id
          LEFT JOIN suppression_entries se ON (se.contact_point_id = cp.id OR se.account_id = cp.account_id) AND se.workspace_id = ${workspaceId}
          WHERE cp.account_id = ${campaignMemberships.accountId}
            AND cd.campaign_id = ${campaignMemberships.campaignId}
            AND cd.decision = 'allowed'
            AND cd.superseded_at IS NULL
            AND cp.verification_status NOT IN ('unverified', 'invalid', 'bounced')
            AND se.id IS NULL
        )`,
        gte(campaignMemberships.updatedAt, today),
        sql`${campaignMemberships.stage} IN ('qualified', 'ready')`
      )
    );

  const targetAchievedToday = settings.targetMetric === "outreach_ready" 
    ? (outreachReadyRow?.total ?? 0) 
    : settings.targetMetric === "analyzed_qualified"
      ? (analyzedQualifiedRow?.total ?? 0)
      : (qualifiedRow?.total ?? 0);

  const [sentRow] = await db
    .select({ total: count() })
    .from(outreachEvents)
    .innerJoin(outreachQueue, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(
      and(eq(campaigns.workspaceId, workspaceId), eq(outreachEvents.state, "sent"), gte(outreachEvents.occurredAt, today)),
    );

  const [repliesRow] = await db
    .select({ total: count() })
    .from(outreachEvents)
    .innerJoin(outreachQueue, eq(outreachEvents.outreachQueueItemId, outreachQueue.id))
    .innerJoin(campaigns, eq(outreachQueue.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(outreachEvents.state, "replied"),
        gte(outreachEvents.occurredAt, today),
      ),
    );

  const [meetingsRow] = await db
    .select({ total: count() })
    .from(meetings)
    .innerJoin(conversations, eq(meetings.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), gte(meetings.createdAt, today)));

  const engines = await listEngineTargets(workspaceId);
  const pacing = await getAutopilotPacingState(workspaceId);
  const targetRisk = pacing.status === "on_pace" || pacing.status === "before_window"
    ? "on_track"
    : pacing.apifyDailyBudgetRemaining <= 0
      ? "target_at_risk_budget"
      : pacing.providerHealth === "paused"
        ? "target_at_risk_provider"
        : pacing.hoursRemaining <= 2 && pacing.remainingTarget > 0
          ? "target_at_risk_time"
          : "recoverable";

  return {
    dailyTarget: settings.globalDailyTarget,
    readyToday: outreachReadyRow?.total ?? 0,
    targetAchievedToday,
    targetMetric: settings.targetMetric,
    sentToday: sentRow?.total ?? 0,
    repliesToday: repliesRow?.total ?? 0,
    meetingsToday: meetingsRow?.total ?? 0,
    readyBufferDays: null,
    systemHealth: "unknown",
    engines,
    pacing,
    targetRisk,
  };
}

export async function listEngineTargets(workspaceId: string): Promise<EngineTargetState[]> {
  return Promise.all(ENGINE_TYPES.map((engineType) => getEngineTargetState(workspaceId, engineType)));
}

async function getEngineTargetState(workspaceId: string, engineType: EngineType): Promise<EngineTargetState> {
  const db = getDb();

  const [targetRow] = await db
    .select({ total: sql<number>`coalesce(sum(${campaigns.dailySoftTarget}), 0)` })
    .from(campaigns)
    .where(
      and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.engineType, engineType), eq(campaigns.autopilotEnabled, true)),
    );

  const [rawDepthRow] = await db
    .select({ total: count() })
    .from(discoveryJobs)
    .innerJoin(campaigns, eq(discoveryJobs.campaignId, campaigns.id))
    .where(
      and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.engineType, engineType), eq(discoveryJobs.status, "pending")),
    );

  const [processingDepthRow] = await db
    .select({ total: count() })
    .from(processingJobs)
    .innerJoin(campaigns, eq(processingJobs.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.engineType, engineType),
        eq(processingJobs.status, "pending"),
      ),
    );

  const [readyRow] = await db
    .select({ total: count() })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.engineType, engineType),
        eq(campaigns.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM autopilot_settings aps
          WHERE aps.workspace_id = ${workspaceId}
            AND aps.emergency_stopped = true
        )`,
        sql`EXISTS (
          SELECT 1 FROM contact_points cp
          JOIN compliance_decisions cd ON cd.contact_point_id = cp.id
          LEFT JOIN suppression_entries se ON (se.contact_point_id = cp.id OR se.account_id = cp.account_id) AND se.workspace_id = ${workspaceId}
          WHERE cp.account_id = ${campaignMemberships.accountId}
            AND cd.campaign_id = ${campaignMemberships.campaignId}
            AND cd.decision = 'allowed'
            AND cd.superseded_at IS NULL
            AND cp.verification_status NOT IN ('unverified', 'invalid', 'bounced')
            AND se.id IS NULL
        )`,
        gte(campaignMemberships.updatedAt, startOfToday((await getAutopilotSettings(workspaceId)).timezone)),
        sql`${campaignMemberships.stage} IN ('qualified', 'ready')`
      ),
    );
    
    const [qualifiedRow] = await db
    .select({ total: count() })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.engineType, engineType),
        gte(campaignMemberships.qualifiedAt, startOfToday((await getAutopilotSettings(workspaceId)).timezone)),
      ),
    );

  const [analyzedQualifiedRow] = await db
    .select({ total: count() })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.engineType, engineType),
        sql`${campaignMemberships.stage} IN ('qualified', 'ready')`,
        gte(campaignMemberships.updatedAt, startOfToday((await getAutopilotSettings(workspaceId)).timezone)),
        sql`EXISTS (
          SELECT 1 FROM prospect_analyses pa
          WHERE pa.campaign_id = ${campaignMemberships.campaignId}
            AND pa.account_id = ${campaignMemberships.accountId}
            AND pa.status = 'completed'
            AND pa.qualified = true
            AND pa.id = (
              SELECT id FROM prospect_analyses pa2
              WHERE pa2.campaign_id = ${campaignMemberships.campaignId}
                AND pa2.account_id = ${campaignMemberships.accountId}
              ORDER BY created_at DESC LIMIT 1
            )
        )`
      ),
    );

  const [yieldRow] = await db
    .select({ avgYield: sql<number>`coalesce(avg(${searchSeeds.yieldRate}), 0)`, lastRunAt: sql<Date | null>`max(${searchSeeds.lastRunAt})` })
    .from(searchSeeds)
    .innerJoin(campaigns, eq(searchSeeds.campaignId, campaigns.id))
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.engineType, engineType)));

  const targetMetric = (await getAutopilotSettings(workspaceId)).targetMetric;
  return {
    engineType,
    softTarget: targetRow?.total ?? 0,
    readyToday: readyRow?.total ?? 0,
    targetAchievedToday: targetMetric === "outreach_ready" 
      ? (readyRow?.total ?? 0) 
      : targetMetric === "analyzed_qualified"
        ? (analyzedQualifiedRow?.total ?? 0)
        : (qualifiedRow?.total ?? 0),
    qualifiedToday: qualifiedRow?.total ?? 0,
    rawQueueDepth: rawDepthRow?.total ?? 0,
    processingQueueDepth: processingDepthRow?.total ?? 0,
    currentYield: yieldRow?.avgYield ?? 0,
    providerHealth: await getEngineProviderHealth(workspaceId, engineType),
    lastRunAt: yieldRow?.lastRunAt ? new Date(yieldRow.lastRunAt).toISOString() : null,
    nextPlannedAction: null,
  };
}

function toRebalanceDecision(row: typeof rebalanceDecisions.$inferSelect): RebalanceDecision {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    fromEngine: row.fromEngine as RebalanceDecision["fromEngine"],
    toEngine: row.toEngine as RebalanceDecision["toEngine"],
    amount: row.amount,
    reason: row.reason,
    fromCampaignId: row.fromCampaignId,
    toCampaignId: row.toCampaignId,
    metricSnapshot: row.metricSnapshot as Record<string, unknown>,
    idempotencyKey: row.idempotencyKey ?? undefined,
  };
}

export async function listRebalanceDecisions(workspaceId: string): Promise<RebalanceDecision[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(rebalanceDecisions)
    .where(eq(rebalanceDecisions.workspaceId, workspaceId))
    .orderBy(sql`${rebalanceDecisions.createdAt} desc`)
    .limit(50);
  return rows.map(toRebalanceDecision);
}

/** Persists one `QuotaRebalancer` decision (Gate E autopilot cron). */
export async function insertRebalanceDecision(workspaceId: string, decision: Omit<RebalanceDecision, "id" | "createdAt">): Promise<void> {
  const db = getDb();
  await db.insert(rebalanceDecisions).values({
    workspaceId,
    fromEngine: decision.fromEngine,
    toEngine: decision.toEngine,
    amount: decision.amount,
    reason: decision.reason,
    fromCampaignId: decision.fromCampaignId ?? null,
    toCampaignId: decision.toCampaignId ?? null,
    metricSnapshot: decision.metricSnapshot ?? {},
    idempotencyKey: decision.idempotencyKey ?? null,
  }).onConflictDoNothing({ target: rebalanceDecisions.idempotencyKey });
}
