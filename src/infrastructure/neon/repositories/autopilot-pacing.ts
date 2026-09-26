import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { getDayBounds } from "@/lib/time/day-bounds";

export interface AutopilotPacingMetrics {
  qualifiedToday: number;
  rawCandidatesToday: number;
  processingInFlight: number;
  providerRunsInFlight: number;
  providerRawItemsInFlight: number;
  apifySpendToday: number;
  historicalRawSampleSize: number;
  historicalQualifiedCount: number;
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Reads the qualified pipeline in workspace-local time. Provider work is
 * reduced by raw candidates already tied to its discovery job, so the same
 * pipeline unit is never counted once as an Apify estimate and again as raw
 * work. A seven-day sample is intentionally small and explainable for the
 * first pacing implementation.
 */
export async function getAutopilotPacingMetrics(workspaceId: string, timeZone: string, now = new Date()): Promise<AutopilotPacingMetrics> {
  const db = getDb();
  const { start, end } = getDayBounds(timeZone, now);
  const historyStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [qualifiedRows, rawRows, processingRows, providerRows, spendRows, historyRows] = await Promise.all([
    db.execute(sql`
      SELECT count(DISTINCT cm.account_id)::int AS total
      FROM campaign_memberships cm
      INNER JOIN campaigns c ON c.id = cm.campaign_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND cm.stage = 'qualified'
        AND cm.updated_at >= ${start.toISOString()}::timestamptz
        AND cm.updated_at < ${end.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM raw_candidates rc
      INNER JOIN campaigns c ON c.id = rc.campaign_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND rc.discovered_at >= ${start.toISOString()}::timestamptz
        AND rc.discovered_at < ${end.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM processing_jobs pj
      INNER JOIN campaigns c ON c.id = pj.campaign_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND pj.status IN ('pending', 'processing')
    `),
    db.execute(sql`
      SELECT
        count(*)::int AS runs,
        coalesce(sum(greatest(pr.items_requested - coalesce(raw.raw_count, 0), 0)), 0)::int AS remaining_items
      FROM provider_runs pr
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS raw_count
        FROM raw_candidates rc
        WHERE rc.discovery_job_id = NULLIF(pr.metadata->>'discoveryJobId', '')::uuid
      ) raw ON true
      WHERE pr.workspace_id = ${workspaceId}::uuid
        AND pr.provider = 'apify'
        AND pr.operation = 'maps_search'
        AND pr.status IN ('starting', 'queued', 'running', 'succeeded')
    `),
    db.execute(sql`
      SELECT coalesce(sum(cost_usd), 0)::numeric AS total
      FROM provider_runs
      WHERE workspace_id = ${workspaceId}::uuid
        AND provider = 'apify'
        AND started_at >= ${start.toISOString()}::timestamptz
        AND started_at < ${end.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT
        count(DISTINCT rc.id) FILTER (WHERE rc.processed = true AND rc.account_id IS NOT NULL)::int AS raw_sample_size,
        count(DISTINCT rc.account_id) FILTER (WHERE cm.account_id IS NOT NULL)::int AS qualified_count
      FROM raw_candidates rc
      INNER JOIN campaigns c ON c.id = rc.campaign_id
      LEFT JOIN campaign_memberships cm
        ON cm.campaign_id = rc.campaign_id AND cm.account_id = rc.account_id
       AND cm.stage = 'qualified'
       AND cm.updated_at >= ${historyStart.toISOString()}::timestamptz
       AND cm.updated_at < ${end.toISOString()}::timestamptz
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND rc.discovered_at >= ${historyStart.toISOString()}::timestamptz
        AND rc.discovered_at < ${end.toISOString()}::timestamptz
    `),
  ]);

  const provider = providerRows.rows[0] as { runs?: unknown; remaining_items?: unknown } | undefined;
  const history = historyRows.rows[0] as { raw_sample_size?: unknown; qualified_count?: unknown } | undefined;
  return {
    qualifiedToday: numberValue((qualifiedRows.rows[0] as { total?: unknown } | undefined)?.total),
    rawCandidatesToday: numberValue((rawRows.rows[0] as { total?: unknown } | undefined)?.total),
    processingInFlight: numberValue((processingRows.rows[0] as { total?: unknown } | undefined)?.total),
    providerRunsInFlight: numberValue(provider?.runs),
    providerRawItemsInFlight: numberValue(provider?.remaining_items),
    apifySpendToday: numberValue((spendRows.rows[0] as { total?: unknown } | undefined)?.total),
    historicalRawSampleSize: numberValue(history?.raw_sample_size),
    historicalQualifiedCount: numberValue(history?.qualified_count),
  };
}