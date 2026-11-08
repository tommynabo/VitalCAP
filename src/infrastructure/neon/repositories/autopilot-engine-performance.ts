import { sql } from "drizzle-orm";
import { emailChannelEligibilitySql } from "@/services/compliance/email-channel-policy";
import { ENGINE_PERFORMANCE_WINDOW_DAYS, selectEnginePerformance, type EnginePerformanceMetric } from "@/services/autopilot/engine-performance";
import { actualPriorColdOutreachSql } from "./actual-outreach";
import { getDb } from "../db";
import type { EngineType } from "@/domain/campaigns/types";

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

export function buildAutopilotEnginePerformanceQuery(workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - ENGINE_PERFORMANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return sql`
    WITH recent_raw AS (
      SELECT rc.id, rc.campaign_id, rc.engine_type, rc.account_id
      FROM raw_candidates rc
      JOIN campaigns c ON c.id = rc.campaign_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND rc.discovered_at >= ${since.toISOString()}::timestamptz
        AND rc.discovered_at < ${now.toISOString()}::timestamptz
        AND rc.engine_type <> 'hybrid_fill'
    ), recent_engine_sources AS (
      SELECT DISTINCT src.account_id, src.source_type
      FROM account_sources src
      JOIN accounts a ON a.id = src.account_id
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND src.discovered_at >= ${since.toISOString()}::timestamptz
        AND src.discovered_at < ${now.toISOString()}::timestamptz
        AND src.source_type IN ('maps_fast', 'maps_deep', 'google_serp', 'linkedin_owner')
    ), recent_campaign_counts AS (
      SELECT account_id,
        count(DISTINCT campaign_id)::int AS campaign_count,
        count(DISTINCT (campaign_id, engine_type))::int AS engine_count
      FROM recent_raw
      WHERE account_id IS NOT NULL
      GROUP BY account_id
    ), unambiguous_sources AS (
      SELECT DISTINCT rr.account_id, rr.campaign_id, rr.engine_type
      FROM recent_raw rr
      JOIN recent_campaign_counts rcc
        ON rcc.account_id = rr.account_id AND rcc.campaign_count = 1 AND rcc.engine_count = 1
      JOIN recent_engine_sources res ON res.account_id = rr.account_id AND res.source_type = rr.engine_type
      WHERE rr.account_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM recent_engine_sources competing
          WHERE competing.account_id = rr.account_id AND competing.source_type <> rr.engine_type
        )
    ), confirmed_imports AS (
      SELECT source.campaign_id, source.engine_type, count(DISTINCT ili.account_id)::int AS confirmed_import_count
      FROM unambiguous_sources source
      JOIN instantly_lead_imports ili
        ON ili.account_id = source.account_id
       AND ili.source_campaign_id = source.campaign_id
      JOIN contact_points cp
        ON cp.id = ili.contact_point_id
       AND cp.workspace_id = ili.workspace_id
       AND cp.account_id = ili.account_id
      WHERE ili.workspace_id = ${workspaceId}::uuid
        AND ili.status = 'instantly_added'
        AND ili.provider_lead_id IS NOT NULL
        AND ili.uploaded_at >= ${since.toISOString()}::timestamptz
        AND ili.uploaded_at < ${now.toISOString()}::timestamptz
        AND cp.type = 'email'
        AND cp.verification_status = 'valid'
        AND cp.verification_provider = 'millionverifier'
        AND lower(trim(cp.normalized_value)) = ili.normalized_email
        AND EXISTS (
          SELECT 1 FROM compliance_decisions cd
          WHERE cd.workspace_id = ili.workspace_id AND cd.channel = 'email'
            AND cd.campaign_id = ili.source_campaign_id
            AND cd.account_id = ili.account_id AND cd.contact_point_id = cp.id
            AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = ili.workspace_id
            AND (se.account_id = ili.account_id OR se.contact_point_id = cp.id)
        )
      GROUP BY source.campaign_id, source.engine_type
    ), campaign_metrics AS (
      SELECT
        c.id AS campaign_id,
        COALESCE(rr.engine_type, c.engine_type) AS engine_type,
        count(rr.id)::int AS raw_count,
        count(DISTINCT rr.account_id) FILTER (WHERE rr.account_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = c.workspace_id AND cp.account_id = rr.account_id
            AND cp.type = 'email' AND cp.verification_status = 'valid'
            AND cp.verification_provider = 'millionverifier'
        ))::int AS exact_mv_valid_count,
        count(DISTINCT rr.account_id) FILTER (WHERE rr.account_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM contact_points cp
          JOIN campaign_memberships cm
            ON cm.campaign_id = c.id AND cm.account_id = rr.account_id
           AND cm.selected_contact_point_id = cp.id AND cm.stage = 'ready'
          JOIN compliance_decisions cd
            ON cd.workspace_id = c.workspace_id AND cd.campaign_id = c.id
           AND cd.account_id = rr.account_id AND cd.contact_point_id = cp.id
          WHERE cp.workspace_id = c.workspace_id AND cp.account_id = rr.account_id
            AND cp.type = 'email' AND cp.verification_status = 'valid'
            AND cp.verification_provider = 'millionverifier'
            AND cp.last_contacted_at IS NULL AND cm.contacted_at IS NULL
            AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
            AND cd.channel = 'email' AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
            AND c.status = 'active'
            AND NOT ${actualPriorColdOutreachSql({ workspaceId: "c.workspace_id", accountId: "rr.account_id", contactPointId: "cp.id", normalizedEmail: "cp.normalized_value" })}
            AND NOT EXISTS (
              SELECT 1 FROM conversations conv
              WHERE conv.workspace_id = c.workspace_id AND conv.account_id = rr.account_id
                AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
            )
            AND NOT EXISTS (
              SELECT 1 FROM meetings m
              JOIN conversations conv ON conv.id = m.conversation_id
              WHERE conv.workspace_id = c.workspace_id AND conv.account_id = rr.account_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM suppression_entries se
              WHERE se.workspace_id = c.workspace_id
                AND (se.account_id = rr.account_id OR se.contact_point_id = cp.id)
            )
        ))::int AS compliance_eligible_exact_mv_count,
        count(DISTINCT rr.account_id) FILTER (WHERE rr.account_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM campaign_memberships cm
          WHERE cm.campaign_id = c.id AND cm.account_id = rr.account_id AND cm.stage = 'ready'
        ))::int AS ready_count
      FROM campaigns c
      LEFT JOIN recent_raw rr ON rr.campaign_id = c.id
      WHERE c.workspace_id = ${workspaceId}::uuid AND c.engine_type <> 'hybrid_fill'
      GROUP BY c.id, COALESCE(rr.engine_type, c.engine_type)
    ), provider_costs AS (
      SELECT run.campaign_id, seed.engine_type,
        CASE WHEN count(*) = 0 THEN NULL ELSE sum(cost_usd) END AS estimated_provider_cost_usd
      FROM provider_runs run
      JOIN search_seeds seed ON seed.id = run.seed_id AND seed.campaign_id = run.campaign_id
      WHERE run.workspace_id = ${workspaceId}::uuid
        AND run.provider IN ('apify', 'serper')
        AND run.campaign_id IS NOT NULL
        AND run.started_at >= ${since.toISOString()}::timestamptz
        AND run.started_at < ${now.toISOString()}::timestamptz
      GROUP BY run.campaign_id, seed.engine_type
    )
    SELECT
      metrics.campaign_id,
      metrics.engine_type,
      metrics.raw_count,
      coalesce(imports.confirmed_import_count, 0)::int AS confirmed_import_count,
      metrics.compliance_eligible_exact_mv_count,
      metrics.exact_mv_valid_count,
      metrics.ready_count,
      costs.estimated_provider_cost_usd
    FROM campaign_metrics metrics
    LEFT JOIN confirmed_imports imports
      ON imports.campaign_id = metrics.campaign_id AND imports.engine_type = metrics.engine_type
    LEFT JOIN provider_costs costs
      ON costs.campaign_id = metrics.campaign_id AND costs.engine_type = metrics.engine_type
  `;
}

export function autopilotEnginePerformanceKey(campaignId: string, engineType: EngineType): string {
  return `${campaignId}:${engineType}`;
}

export async function getAutopilotEnginePerformance(
  workspaceId: string,
  now: Date,
): Promise<Map<string, EnginePerformanceMetric>> {
  const result = await getDb().execute(buildAutopilotEnginePerformanceQuery(workspaceId, now));
  const performanceByCampaign = new Map<string, EnginePerformanceMetric>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const campaignId = String(row.campaign_id);
    const engineType = String(row.engine_type) as EngineType;
    const cost = row.estimated_provider_cost_usd;
    performanceByCampaign.set(autopilotEnginePerformanceKey(campaignId, engineType), selectEnginePerformance({
      rawCount: numberValue(row.raw_count),
      confirmedImportCount: numberValue(row.confirmed_import_count),
      complianceEligibleExactMvCount: numberValue(row.compliance_eligible_exact_mv_count),
      exactMvValidCount: numberValue(row.exact_mv_valid_count),
      readyCount: numberValue(row.ready_count),
      estimatedProviderCostUsd: cost === null || cost === undefined ? null : Number(cost),
    }));
  }
  return performanceByCampaign;
}