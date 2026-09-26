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
import type { AutopilotSettings, EngineTargetState, GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";
import { getDayBounds } from "@/lib/time/day-bounds";

const DEFAULT_AUTOPILOT_SETTINGS = {
  enabled: false,
  emergencyStopped: false,
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
  return db.transaction(async (tx) => {
    await tx.insert(autopilotSettings).values({ workspaceId: input.workspaceId, ...DEFAULT_AUTOPILOT_SETTINGS }).onConflictDoNothing({ target: autopilotSettings.workspaceId });
    const [updated] = await tx.update(autopilotSettings).set({ ...input.patch, updatedAt: new Date() }).where(eq(autopilotSettings.workspaceId, input.workspaceId)).returning();
    if (!updated) throw new Error("Failed to update Autopilot settings.");
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      actorUserId: input.audit.actorUserId,
      action: input.audit.action,
      entityType: "autopilot_settings",
      entityId: input.workspaceId,
      metadata: input.audit.metadata,
    });
    return toAutopilotSettings(updated);
  });
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
    .select({ total: count() })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaignMemberships.campaignId, campaigns.id))
    .where(
      and(eq(campaigns.workspaceId, workspaceId), eq(campaignMemberships.stage, "qualified"), gte(campaignMemberships.updatedAt, today)),
    );

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

  return {
    dailyTarget: settings.globalDailyTarget,
    readyToday: qualifiedRow?.total ?? 0,
    targetAchievedToday: qualifiedRow?.total ?? 0,
    targetMetric: settings.targetMetric,
    sentToday: sentRow?.total ?? 0,
    repliesToday: repliesRow?.total ?? 0,
    meetingsToday: meetingsRow?.total ?? 0,
    readyBufferDays: null,
    systemHealth: "unknown",
    engines,
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
        eq(campaignMemberships.stage, "qualified"),
        gte(campaignMemberships.updatedAt, startOfToday((await getAutopilotSettings(workspaceId)).timezone)),
      ),
    );

  const [yieldRow] = await db
    .select({ avgYield: sql<number>`coalesce(avg(${searchSeeds.yieldRate}), 0)`, lastRunAt: sql<Date | null>`max(${searchSeeds.lastRunAt})` })
    .from(searchSeeds)
    .innerJoin(campaigns, eq(searchSeeds.campaignId, campaigns.id))
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.engineType, engineType)));

  return {
    engineType,
    softTarget: targetRow?.total ?? 0,
    readyToday: readyRow?.total ?? 0,
    qualifiedToday: readyRow?.total ?? 0,
    rawQueueDepth: rawDepthRow?.total ?? 0,
    processingQueueDepth: processingDepthRow?.total ?? 0,
    currentYield: yieldRow?.avgYield ?? 0,
    providerHealth: "unknown",
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
  });
}
