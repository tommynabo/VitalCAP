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
  qualifiedContactabilityBacklog: number;
  qualifiedAccounts: number;
  qualifiedWithDomain: number;
  qualifiedWithoutValidEmail: number;
  qualifiedDomainWithoutValidEmail: number;
  qualifiedRecoveryEligibleWithoutValidEmail: number;
  qualifiedTerminalNoMatchWithoutValidEmail: number;
  validEmailAccounts: number;
  confirmedImportsToday: number;
  contactabilityHistoricalSample: number;
  contactabilityImportYield: number;
  expectedImportsFromContactabilityBacklog: number;
  recoveryOutcomes: {
    attempted: number;
    succeeded: number;
    terminalNoMatch: number;
    transientFailure: number;
    providerBlocked: number;
    budgetBlocked: number;
    legacyUnclassifiedFailure: number;
    fetchSucceeded: number;
    fetchFailed: number;
    emailAccountsCreated: number;
    validEmailAccounts: number;
    confirmedImportedAccounts: number;
  };
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
  const contactabilityHistoryStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [qualifiedRows, rawRows, rawRequestedRows, processingRows, providerRows, spendRows, historyRows, funnelRows, verificationRows, contactabilityRows] = await Promise.all([
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
        AND provider IN ('apify', 'serper')
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
    db.execute(sql`
      WITH qualified AS MATERIALIZED (
        SELECT DISTINCT c.workspace_id, c.id AS campaign_id, cm.account_id, cm.qualified_at
        FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id
        WHERE c.workspace_id = ${workspaceId}::uuid
          AND c.status = 'active'
          AND cm.qualified_at IS NOT NULL
          AND cm.stage NOT IN ('rejected', 'suppressed')
      ),
      current_accounts AS (
        SELECT q.account_id, q.campaign_id, q.qualified_at,
          (NULLIF(TRIM(a.website_url), '') IS NOT NULL OR NULLIF(TRIM(a.normalized_domain), '') IS NOT NULL) AS has_domain,
          EXISTS (
            SELECT 1 FROM contact_points cp
            WHERE cp.workspace_id = q.workspace_id AND cp.account_id = q.account_id
              AND cp.type = 'email' AND cp.verification_status = 'valid'
              AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
          ) AS has_valid_email,
          EXISTS (
            SELECT 1 FROM campaign_memberships selected_cm
            JOIN campaigns selected_campaign ON selected_campaign.id = selected_cm.campaign_id
              AND selected_campaign.status = 'active'
            JOIN contact_points selected_cp ON selected_cp.id = selected_cm.selected_contact_point_id
            WHERE selected_campaign.workspace_id = q.workspace_id
              AND selected_cm.account_id = q.account_id
              AND selected_cm.stage <> 'rejected'
              AND selected_cp.type = 'email' AND selected_cp.verification_status = 'valid'
              AND NULLIF(TRIM(selected_cp.normalized_value), '') IS NOT NULL
          ) AS has_valid_selected_email,
          EXISTS (
            SELECT 1 FROM instantly_lead_imports ili
            WHERE ili.workspace_id = q.workspace_id AND ili.account_id = q.account_id
              AND ili.provider_campaign_id = ${providerCampaignId ?? ''}
              AND ili.status = 'instantly_added' AND ili.provider_lead_id IS NOT NULL
          ) AS confirmed_imported,
          EXISTS (
            SELECT 1 FROM raw_candidates rc
            WHERE rc.campaign_id = q.campaign_id AND rc.account_id = q.account_id
              AND rc.engine_type = 'maps_fast'
              AND COALESCE(rc.processing_metrics->>'websiteRecoveryStatus', 'not_attempted')
                IN ('not_attempted', 'started', 'succeeded', 'transient_failure', 'provider_blocked', 'budget_blocked', 'blocked')
              AND length(trim(rc.raw_payload #>> '{place,name}')) >= 7
              AND array_length(regexp_split_to_array(trim(rc.raw_payload #>> '{place,name}'), '[[:space:]]+'), 1) >= 2
              AND (
                NULLIF(trim(rc.raw_payload #>> '{place,city}'), '') IS NOT NULL
                OR NULLIF(trim(rc.raw_payload #>> '{place,province}'), '') IS NOT NULL
                OR length(regexp_replace(COALESCE(rc.raw_payload #>> '{place,phone}', ''), '[^0-9]', '', 'g')) >= 9
              )
          ) AS recovery_eligible,
          EXISTS (
            SELECT 1 FROM raw_candidates rc
            WHERE rc.campaign_id = q.campaign_id AND rc.account_id = q.account_id
              AND rc.engine_type = 'maps_fast'
              AND rc.processing_metrics->>'websiteRecoveryStatus' = 'terminal_no_match'
          ) AS terminal_no_match,
          NOT EXISTS (
            SELECT 1 FROM suppression_entries se
            WHERE se.workspace_id = q.workspace_id AND (
              se.account_id = q.account_id
              OR se.contact_point_id IN (
                SELECT cp.id FROM contact_points cp
                WHERE cp.workspace_id = q.workspace_id AND cp.account_id = q.account_id
              )
            )
          ) AND NOT EXISTS (
            SELECT 1 FROM conversations conv
            WHERE conv.workspace_id = q.workspace_id AND conv.account_id = q.account_id
              AND conv.state = 'suppressed'
          ) AS not_suppressed
        FROM qualified q
        JOIN accounts a ON a.id = q.account_id AND a.workspace_id = q.workspace_id
      ),
      historical_candidates AS MATERIALIZED (
        SELECT DISTINCT q.workspace_id, q.campaign_id, q.account_id, q.qualified_at
        FROM qualified q
        JOIN accounts a ON a.id = q.account_id AND a.workspace_id = q.workspace_id
        WHERE q.qualified_at >= ${contactabilityHistoryStart.toISOString()}::timestamptz
          AND q.qualified_at < ${now.toISOString()}::timestamptz
          AND (
            NULLIF(TRIM(a.website_url), '') IS NOT NULL
            OR NULLIF(TRIM(a.normalized_domain), '') IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM raw_candidates rc
              WHERE rc.campaign_id = q.campaign_id AND rc.account_id = q.account_id
                AND rc.engine_type = 'maps_fast'
                AND rc.discovered_at <= q.qualified_at
                AND rc.processing_metrics->>'websiteRecoveryStatus' IN (
                  'started', 'succeeded', 'terminal_no_match', 'transient_failure', 'provider_blocked', 'budget_blocked', 'blocked'
                )
                AND length(trim(rc.raw_payload #>> '{place,name}')) >= 7
                AND array_length(regexp_split_to_array(trim(rc.raw_payload #>> '{place,name}'), '[[:space:]]+'), 1) >= 2
                AND (
                  NULLIF(trim(rc.raw_payload #>> '{place,city}'), '') IS NOT NULL
                  OR NULLIF(trim(rc.raw_payload #>> '{place,province}'), '') IS NOT NULL
                  OR length(regexp_replace(COALESCE(rc.raw_payload #>> '{place,phone}', ''), '[^0-9]', '', 'g')) >= 9
                )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM contact_points prior_cp
            WHERE prior_cp.workspace_id = q.workspace_id AND prior_cp.account_id = q.account_id
              AND prior_cp.type = 'email' AND prior_cp.verification_status = 'valid'
              AND NULLIF(TRIM(prior_cp.normalized_value), '') IS NOT NULL
              AND COALESCE(prior_cp.verification_checked_at, prior_cp.created_at) <= q.qualified_at
          )
          AND (
            EXISTS (
              SELECT 1 FROM contact_points resolved_cp
              WHERE resolved_cp.workspace_id = q.workspace_id AND resolved_cp.account_id = q.account_id
                AND resolved_cp.type = 'email'
                AND resolved_cp.source_type IN ('website', 'website_enrichment')
                AND resolved_cp.verification_status IN ('valid', 'invalid', 'disposable', 'bounced')
                AND COALESCE(resolved_cp.verification_checked_at, resolved_cp.updated_at) >= q.qualified_at
            )
            OR EXISTS (
              SELECT 1 FROM raw_candidates terminal_rc
              WHERE terminal_rc.campaign_id = q.campaign_id AND terminal_rc.account_id = q.account_id
                AND terminal_rc.engine_type = 'maps_fast'
                AND terminal_rc.processing_metrics->>'websiteRecoveryStatus' = 'terminal_no_match'
            )
            OR EXISTS (
              SELECT 1 FROM raw_candidates completed_rc
              WHERE completed_rc.campaign_id = q.campaign_id AND completed_rc.account_id = q.account_id
                AND completed_rc.discovered_at <= q.qualified_at
                AND completed_rc.processing_metrics->>'websiteEmailAttributionComplete' = 'true'
                AND NULLIF(completed_rc.processing_metrics->>'websiteAttributionStartedAt', '') IS NOT NULL
                AND NULLIF(completed_rc.processing_metrics->>'websiteAttributionCompletedAt', '') IS NOT NULL
                AND NULLIF(completed_rc.processing_metrics->>'websiteAttributionCompletedAt', '')::timestamptz >= q.qualified_at
                AND COALESCE(completed_rc.processing_metrics->>'websiteRecoveryStatus', '')
                  IN ('', 'succeeded', 'terminal_no_match')
            )
          )
      ),
      recovery_scope AS MATERIALIZED (
        SELECT rc.id, rc.account_id, rc.campaign_id,
          COALESCE(rc.processing_metrics, '{}'::jsonb) AS metrics
        FROM raw_candidates rc
        JOIN campaigns c ON c.id = rc.campaign_id AND c.workspace_id = ${workspaceId}::uuid
        WHERE c.status = 'active' AND rc.engine_type = 'maps_fast'
          AND rc.discovered_at >= ${contactabilityHistoryStart.toISOString()}::timestamptz
          AND rc.discovered_at < ${now.toISOString()}::timestamptz
      ),
      current_summary AS (
        SELECT
          count(DISTINCT account_id)::int AS qualified_accounts,
          count(DISTINCT account_id) FILTER (WHERE has_domain)::int AS qualified_with_domain,
          count(DISTINCT account_id) FILTER (WHERE NOT has_valid_email)::int AS qualified_without_valid_email,
          count(DISTINCT account_id) FILTER (WHERE has_domain AND NOT has_valid_email)::int AS qualified_domain_without_valid_email,
          count(DISTINCT account_id) FILTER (WHERE recovery_eligible AND NOT has_valid_email)::int AS qualified_recovery_eligible_without_valid_email,
          count(DISTINCT account_id) FILTER (WHERE terminal_no_match AND NOT has_valid_email)::int AS qualified_terminal_no_match_without_valid_email,
          count(DISTINCT account_id) FILTER (WHERE has_valid_email)::int AS valid_email_accounts,
          count(DISTINCT account_id) FILTER (
            WHERE not_suppressed AND NOT has_valid_selected_email AND NOT has_valid_email AND NOT confirmed_imported
              AND (has_domain OR recovery_eligible)
          )::int AS qualified_contactability_backlog
        FROM current_accounts
      ),
      history_summary AS (
        SELECT
          count(DISTINCT hc.account_id)::int AS resolved_sample,
          count(DISTINCT hc.account_id) FILTER (WHERE EXISTS (
            SELECT 1 FROM instantly_lead_imports imported
            JOIN contact_points imported_cp ON imported_cp.id = imported.contact_point_id
              AND imported_cp.account_id = imported.account_id
            WHERE imported.workspace_id = hc.workspace_id AND imported.account_id = hc.account_id
              AND imported.provider_campaign_id = ${providerCampaignId ?? ''}
              AND imported.status = 'instantly_added' AND imported.provider_lead_id IS NOT NULL
              AND imported.uploaded_at >= hc.qualified_at
              AND imported_cp.type = 'email' AND imported_cp.verification_status = 'valid'
              AND imported_cp.source_type IN ('website', 'website_enrichment')
              AND imported_cp.created_at >= hc.qualified_at
          ))::int AS confirmed_imports
        FROM historical_candidates hc
      ),
      recovery_summary AS (
        SELECT
          count(DISTINCT id) FILTER (WHERE COALESCE(NULLIF(metrics->>'websiteRecoveryAttempted', '')::int, 0) > 0
            OR metrics->>'websiteRecoveryStatus' IN ('succeeded', 'terminal_no_match', 'transient_failure', 'failed'))::int AS attempted,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'succeeded')::int AS succeeded,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'terminal_no_match')::int AS terminal_no_match,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'transient_failure')::int AS transient_failure,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'provider_blocked')::int AS provider_blocked,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'budget_blocked')::int AS budget_blocked,
          count(DISTINCT id) FILTER (WHERE metrics->>'websiteRecoveryStatus' = 'failed')::int AS legacy_unclassified_failure,
          count(DISTINCT account_id) FILTER (WHERE COALESCE(NULLIF(metrics->>'recoveredWebsiteFetchSucceeded', '')::int, 0) > 0)::int AS fetch_succeeded,
          count(DISTINCT account_id) FILTER (WHERE COALESCE(NULLIF(metrics->>'recoveredWebsiteFetchFailed', '')::int, 0) > 0)::int AS fetch_failed,
          count(DISTINCT account_id) FILTER (WHERE metrics->>'websiteOrigin' = 'recovered' AND EXISTS (
            SELECT 1 FROM contact_points cp
            WHERE cp.account_id = recovery_scope.account_id AND cp.workspace_id = ${workspaceId}::uuid
              AND cp.type = 'email' AND cp.source_type IN ('website', 'website_enrichment')
              AND cp.created_at >= NULLIF(metrics->>'websiteAttributionStartedAt', '')::timestamptz
              AND cp.created_at <= NULLIF(metrics->>'websiteAttributionCompletedAt', '')::timestamptz
          ))::int AS email_accounts_created,
          count(DISTINCT account_id) FILTER (WHERE metrics->>'websiteOrigin' = 'recovered' AND EXISTS (
            SELECT 1 FROM contact_points cp
            WHERE cp.account_id = recovery_scope.account_id AND cp.workspace_id = ${workspaceId}::uuid
              AND cp.type = 'email' AND cp.source_type IN ('website', 'website_enrichment')
              AND cp.verification_status = 'valid'
              AND cp.created_at >= NULLIF(metrics->>'websiteAttributionStartedAt', '')::timestamptz
              AND cp.created_at <= NULLIF(metrics->>'websiteAttributionCompletedAt', '')::timestamptz
          ))::int AS recovery_valid_email_accounts,
          count(DISTINCT account_id) FILTER (WHERE metrics->>'websiteOrigin' = 'recovered' AND EXISTS (
            SELECT 1 FROM instantly_lead_imports imported
            JOIN contact_points cp ON cp.id = imported.contact_point_id AND cp.account_id = imported.account_id
            WHERE imported.workspace_id = ${workspaceId}::uuid AND imported.account_id = recovery_scope.account_id
              AND imported.provider_campaign_id = ${providerCampaignId ?? ''}
              AND imported.status = 'instantly_added' AND imported.provider_lead_id IS NOT NULL
              AND imported.uploaded_at >= NULLIF(metrics->>'websiteAttributionCompletedAt', '')::timestamptz
              AND cp.type = 'email' AND cp.verification_status = 'valid'
          ))::int AS confirmed_imported_accounts
        FROM recovery_scope
      )
      SELECT current_summary.*, history_summary.resolved_sample, history_summary.confirmed_imports,
        recovery_summary.*
      FROM current_summary CROSS JOIN history_summary CROSS JOIN recovery_summary
    `),
  ]);
  const provider = providerRows.rows[0] as { runs?: unknown; remaining_items?: unknown } | undefined;
  const history = historyRows.rows[0] as { raw_sample_size?: unknown; qualified_count?: unknown } | undefined;
  const funnel = funnelRows.rows[0] as { discovered?: unknown; with_email?: unknown; valid_email?: unknown; eligible?: unknown } | undefined;
  const contactability = contactabilityRows.rows[0] as Record<string, unknown> | undefined;
  const contactabilityHistoricalSample = numberValue(contactability?.resolved_sample);
  const contactabilityImportYield = contactabilityHistoricalSample >= 20
    ? Math.min(0.3, numberValue(contactability?.confirmed_imports) / contactabilityHistoricalSample)
    : 0;
  const qualifiedContactabilityBacklog = numberValue(contactability?.qualified_contactability_backlog);
  const [importStatsRows, importHistoryRows, importBacklogRows] = await Promise.all([
    db.execute(sql`
      SELECT count(DISTINCT ili.account_id)::int AS total
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
  const confirmedImportsToday = providerCampaignId ? numberValue(importStatsRows.rows[0]?.total) : 0;
  return {
    discoveredToday: numberValue(funnel?.discovered),
    withEmailToday: numberValue(funnel?.with_email),
    validEmailToday: numberValue(funnel?.valid_email),
    eligibleToday: numberValue(funnel?.eligible),
    verificationInFlight: numberValue(verificationRows.rows[0]?.total),
    qualifiedToday: numberValue((qualifiedRows.rows[0] as { total?: unknown } | undefined)?.total),
    instantlyImportedToday: confirmedImportsToday,
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
    qualifiedContactabilityBacklog,
    qualifiedAccounts: numberValue(contactability?.qualified_accounts),
    qualifiedWithDomain: numberValue(contactability?.qualified_with_domain),
    qualifiedWithoutValidEmail: numberValue(contactability?.qualified_without_valid_email),
    qualifiedDomainWithoutValidEmail: numberValue(contactability?.qualified_domain_without_valid_email),
    qualifiedRecoveryEligibleWithoutValidEmail: numberValue(contactability?.qualified_recovery_eligible_without_valid_email),
    qualifiedTerminalNoMatchWithoutValidEmail: numberValue(contactability?.qualified_terminal_no_match_without_valid_email),
    validEmailAccounts: numberValue(contactability?.valid_email_accounts),
    confirmedImportsToday,
    contactabilityHistoricalSample,
    contactabilityImportYield,
    expectedImportsFromContactabilityBacklog: Math.floor(qualifiedContactabilityBacklog * contactabilityImportYield),
    recoveryOutcomes: {
      attempted: numberValue(contactability?.attempted),
      succeeded: numberValue(contactability?.succeeded),
      terminalNoMatch: numberValue(contactability?.terminal_no_match),
      transientFailure: numberValue(contactability?.transient_failure),
      providerBlocked: numberValue(contactability?.provider_blocked),
      budgetBlocked: numberValue(contactability?.budget_blocked),
      legacyUnclassifiedFailure: numberValue(contactability?.legacy_unclassified_failure),
      fetchSucceeded: numberValue(contactability?.fetch_succeeded),
      fetchFailed: numberValue(contactability?.fetch_failed),
      emailAccountsCreated: numberValue(contactability?.email_accounts_created),
      validEmailAccounts: numberValue(contactability?.recovery_valid_email_accounts),
      confirmedImportedAccounts: numberValue(contactability?.confirmed_imported_accounts),
    },
  };
}
