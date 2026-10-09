import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { getDayBounds } from "@/lib/time/day-bounds";
import { emailChannelEligibilitySql } from "@/services/compliance/email-channel-policy";
import { actualPriorColdOutreachSql } from "./actual-outreach";

export interface AutopilotPacingMetrics {
  discoveredToday: number;
  withEmailToday: number;
  validEmailToday: number;
  eligibleToday: number;
  verificationInFlight: number;
  qualifiedToday: number;
  instantlyImportedToday: number;
  eligibleImportBacklog: number;
  historicalImportCount: number;
  historicalImportSourceCount: number;
  rawRequestedToday: number;
  rawReturnedToday: number;
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
export async function getAutopilotPacingMetrics(
  workspaceId: string,
  timeZone: string,
  now = new Date(),
  providerCampaignId: string | null = null,
): Promise<AutopilotPacingMetrics> {
  const db = getDb();
  const { start, end } = getDayBounds(timeZone, now);
  const historyStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [qualifiedRows, rawRows, rawRequestedRows, processingRows, providerRows, spendRows, historyRows, funnelRows, verificationRows] = await Promise.all([
    db.execute(sql`
      SELECT count(DISTINCT cm.account_id)::int AS total
      FROM campaign_memberships cm
      INNER JOIN campaigns c ON c.id = cm.campaign_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND cm.qualified_at IS NOT NULL
        AND cm.qualified_at >= ${start.toISOString()}::timestamptz
        AND cm.qualified_at < ${end.toISOString()}::timestamptz
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
      SELECT coalesce(sum(items_requested), 0)::int AS total
      FROM provider_runs
      WHERE workspace_id = ${workspaceId}::uuid
        AND started_at >= ${start.toISOString()}::timestamptz
        AND started_at < ${end.toISOString()}::timestamptz
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
        WHERE rc.provider_run_id = pr.id
      ) raw ON true
      WHERE pr.workspace_id = ${workspaceId}::uuid
        AND pr.status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting')
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
       AND cm.qualified_at IS NOT NULL
       AND cm.qualified_at >= ${historyStart.toISOString()}::timestamptz
       AND cm.qualified_at < ${end.toISOString()}::timestamptz
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND rc.discovered_at >= ${historyStart.toISOString()}::timestamptz
        AND rc.discovered_at < ${end.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT
        count(DISTINCT a.id)::int AS discovered,
        count(DISTINCT a.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = a.workspace_id AND cp.account_id = a.id
            AND cp.type = 'email' AND trim(cp.normalized_value) <> ''
        ))::int AS with_email,
        count(DISTINCT a.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = a.workspace_id AND cp.account_id = a.id
            AND cp.type = 'email' AND cp.verification_status = 'valid'
        ))::int AS valid_email,
        count(DISTINCT a.id) FILTER (WHERE EXISTS (
          SELECT 1
          FROM contact_points cp
          JOIN campaign_memberships cm
            ON cm.account_id = a.id AND cm.selected_contact_point_id = cp.id AND cm.stage = 'ready'
          JOIN campaigns c ON c.id = cm.campaign_id AND c.workspace_id = a.workspace_id AND c.status = 'active'
          JOIN compliance_decisions cd
            ON cd.workspace_id = a.workspace_id AND cd.campaign_id = cm.campaign_id
           AND cd.account_id = a.id AND cd.contact_point_id = cp.id
          WHERE cp.workspace_id = a.workspace_id AND cp.account_id = a.id
            AND cp.type = 'email' AND cp.verification_status = 'valid'
            AND cp.last_contacted_at IS NULL AND cm.contacted_at IS NULL
            AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
            AND cd.channel = 'email' AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
            AND NOT ${actualPriorColdOutreachSql({
              workspaceId: "a.workspace_id",
              accountId: "a.id",
              contactPointId: "cp.id",
              normalizedEmail: "cp.normalized_value",
            })}
            AND NOT EXISTS (
              SELECT 1 FROM conversations conv
              WHERE conv.workspace_id = a.workspace_id AND conv.account_id = a.id
                AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
            )
            AND NOT EXISTS (
              SELECT 1 FROM meetings m
              JOIN conversations conv ON conv.id = m.conversation_id
              WHERE conv.workspace_id = a.workspace_id AND conv.account_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM suppression_entries se
              WHERE se.workspace_id = a.workspace_id
                AND (se.account_id = a.id OR se.contact_point_id = cp.id)
            )
        ))::int AS eligible
      FROM account_sources src
      JOIN accounts a ON a.id = src.account_id
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND src.discovered_at >= ${start.toISOString()}::timestamptz
        AND src.discovered_at < ${end.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT count(DISTINCT vj.contact_point_id)::int AS total
      FROM verification_jobs vj
      JOIN contact_points cp ON cp.id = vj.contact_point_id
      WHERE vj.workspace_id = ${workspaceId}::uuid
        AND vj.status IN ('pending', 'processing')
        AND vj.attempt_count < vj.max_attempts
        AND cp.type = 'email'
        AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
        AND EXISTS (
          SELECT 1 FROM campaign_memberships cm
          JOIN campaigns c ON c.id = cm.campaign_id
          WHERE cm.account_id = cp.account_id
            AND cm.selected_contact_point_id = cp.id
            AND cm.stage = 'ready' AND c.status = 'active'
            AND c.workspace_id = vj.workspace_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = vj.workspace_id
            AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
        )
        AND NOT ${actualPriorColdOutreachSql({
          workspaceId: "vj.workspace_id",
          accountId: "cp.account_id",
          contactPointId: "cp.id",
          normalizedEmail: "cp.normalized_value",
        })}
    `),
  ]);

  const provider = providerRows.rows[0] as { runs?: unknown; remaining_items?: unknown } | undefined;
  const history = historyRows.rows[0] as { raw_sample_size?: unknown; qualified_count?: unknown } | undefined;
  const funnel = funnelRows.rows[0] as { discovered?: unknown; with_email?: unknown; valid_email?: unknown; eligible?: unknown } | undefined;
  const [importStatsRows, importHistoryRows, importBacklogRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM instantly_lead_imports ili
      JOIN contact_points cp ON cp.id = ili.contact_point_id
      WHERE ili.workspace_id = ${workspaceId}::uuid
        AND ili.provider_campaign_id = ${providerCampaignId ?? ""}
        AND ili.status = 'instantly_added'
        AND ili.provider_lead_id IS NOT NULL
        AND ili.uploaded_at >= ${start.toISOString()}::timestamptz
        AND ili.uploaded_at < ${end.toISOString()}::timestamptz
        AND cp.type = 'email'
        AND lower(trim(cp.normalized_value)) = ili.normalized_email
        AND cp.verification_status = 'valid'
        AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
        AND EXISTS (
          SELECT 1 FROM compliance_decisions cd
          WHERE cd.workspace_id = ili.workspace_id AND cd.channel = 'email'
            AND cd.campaign_id = ili.source_campaign_id
            AND cd.account_id = ili.account_id
            AND cd.contact_point_id = cp.id
            AND cd.decision = 'allowed'
            AND cd.superseded_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = ili.workspace_id
            AND (se.account_id = ili.account_id OR se.contact_point_id = cp.id)
        )
    `),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int
         FROM instantly_lead_imports ili
         WHERE ili.workspace_id = ${workspaceId}::uuid
           AND ili.provider_campaign_id = ${providerCampaignId ?? ""}
           AND ili.status = 'instantly_added'
           AND ili.provider_lead_id IS NOT NULL
           AND ili.uploaded_at >= ${historyStart.toISOString()}::timestamptz
           AND ili.uploaded_at < ${end.toISOString()}::timestamptz
        ) AS imported_count,
        (SELECT count(DISTINCT src.account_id)::int
         FROM account_sources src
         JOIN accounts a ON a.id = src.account_id
         WHERE a.workspace_id = ${workspaceId}::uuid
           AND src.discovered_at >= ${historyStart.toISOString()}::timestamptz
           AND src.discovered_at < ${end.toISOString()}::timestamptz
        ) AS source_count
    `),
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM instantly_lead_imports ili
      JOIN contact_points cp ON cp.id = ili.contact_point_id
      WHERE ili.workspace_id = ${workspaceId}::uuid
        AND ili.provider_campaign_id = ${providerCampaignId ?? ""}
        AND (
          ili.status IN ('eligible', 'instantly_queued')
          OR (ili.status IN ('failed', 'deferred') AND ili.next_attempt_at <= ${now.toISOString()}::timestamptz)
        )
        AND ili.attempt_count < ili.max_attempts
        AND cp.verification_status = 'valid'
        AND lower(trim(cp.normalized_value)) = ili.normalized_email
        AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
        AND EXISTS (
          SELECT 1 FROM compliance_decisions cd
          WHERE cd.workspace_id = ili.workspace_id AND cd.channel = 'email'
            AND cd.campaign_id = ili.source_campaign_id
            AND cd.account_id = ili.account_id
            AND cd.contact_point_id = cp.id
            AND cd.decision = 'allowed'
            AND cd.superseded_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = ili.workspace_id
            AND (se.account_id = ili.account_id OR se.contact_point_id = cp.id)
        )
        AND EXISTS (
          SELECT 1 FROM campaign_memberships cm
          JOIN campaigns c ON c.id = cm.campaign_id
          WHERE cm.campaign_id = ili.source_campaign_id
            AND cm.account_id = ili.account_id
            AND cm.selected_contact_point_id = cp.id
            AND cm.stage = 'ready' AND c.status = 'active'
            AND c.workspace_id = ili.workspace_id
        )
        AND NOT ${actualPriorColdOutreachSql({
          workspaceId: "ili.workspace_id",
          accountId: "ili.account_id",
          contactPointId: "cp.id",
          normalizedEmail: "cp.normalized_value",
        })}
    `),
  ]);
  const importHistory = importHistoryRows.rows[0] as { imported_count?: unknown; source_count?: unknown } | undefined;
  return {
    discoveredToday: numberValue(funnel?.discovered),
    withEmailToday: numberValue(funnel?.with_email),
    validEmailToday: numberValue(funnel?.valid_email),
    eligibleToday: numberValue(funnel?.eligible),
    verificationInFlight: numberValue(verificationRows.rows[0]?.total),
    qualifiedToday: numberValue((qualifiedRows.rows[0] as { total?: unknown } | undefined)?.total),
    instantlyImportedToday: providerCampaignId ? numberValue(importStatsRows.rows[0]?.total) : 0,
    eligibleImportBacklog: providerCampaignId ? numberValue(importBacklogRows.rows[0]?.total) : 0,
    historicalImportCount: providerCampaignId ? numberValue(importHistory?.imported_count) : 0,
    historicalImportSourceCount: numberValue(importHistory?.source_count),
    rawRequestedToday: numberValue((rawRequestedRows.rows[0] as { total?: unknown } | undefined)?.total),
    rawReturnedToday: numberValue((rawRows.rows[0] as { total?: unknown } | undefined)?.total),
    processingInFlight: numberValue((processingRows.rows[0] as { total?: unknown } | undefined)?.total),
    providerRunsInFlight: numberValue(provider?.runs),
    providerRawItemsInFlight: numberValue(provider?.remaining_items),
    apifySpendToday: numberValue((spendRows.rows[0] as { total?: unknown } | undefined)?.total),
    historicalRawSampleSize: numberValue(history?.raw_sample_size),
    historicalQualifiedCount: numberValue(history?.qualified_count),
  };
}
