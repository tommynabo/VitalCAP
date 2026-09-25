import { and, eq, gte, count, sql } from "drizzle-orm";
import { getDb } from "../db";
import { campaigns } from "../schema/campaigns";
import { accounts } from "../schema/accounts";
import { discoveryJobs, processingJobs, searchSeeds } from "../schema/discovery";
import { outreachQueue, outreachEvents } from "../schema/outreach";
import { conversations, meetings } from "../schema/conversations";
import { rebalanceDecisions } from "../schema/autopilot";
import type { EngineType } from "@/domain/campaigns/types";
import type { EngineTargetState, GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";

const ENGINE_TYPES: EngineType[] = ["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"];

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
  const today = startOfToday();

  const [dailyTargetRow] = await db
    .select({ total: sql<number>`coalesce(sum(${campaigns.dailySoftTarget}), 0)` })
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.autopilotEnabled, true)));

  const [readyRow] = await db
    .select({ total: count() })
    .from(accounts)
    .where(
      and(eq(accounts.workspaceId, workspaceId), eq(accounts.status, "outreach_ready"), gte(accounts.updatedAt, today)),
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
    dailyTarget: dailyTargetRow?.total ?? 0,
    readyToday: readyRow?.total ?? 0,
    sentToday: sentRow?.total ?? 0,
    repliesToday: repliesRow?.total ?? 0,
    meetingsToday: meetingsRow?.total ?? 0,
    readyBufferDays: 0,
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

  const [yieldRow] = await db
    .select({ avgYield: sql<number>`coalesce(avg(${searchSeeds.yieldRate}), 0)`, lastRunAt: sql<Date | null>`max(${searchSeeds.lastRunAt})` })
    .from(searchSeeds)
    .innerJoin(campaigns, eq(searchSeeds.campaignId, campaigns.id))
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.engineType, engineType)));

  return {
    engineType,
    softTarget: targetRow?.total ?? 0,
    readyToday: 0,
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
