import { sql } from "drizzle-orm";

export interface WebsiteRecoveryAttributionPeriod {
  name: string;
  start: Date;
  end: Date;
}

export interface WebsiteRecoveryAttributionQueryInput {
  workspaceId: string;
  targetProviderCampaignId: string | null;
  periods: WebsiteRecoveryAttributionPeriod[];
}

const RECOVERY_TELEMETRY_KEYS = [
  "websiteOrigin",
  "websiteRecoveryAttempted",
  "websiteRecoverySucceeded",
  "websiteRecoveryFailed",
  "websiteRecoveryStatus",
  "websiteRecoverySource",
  "recoveredWebsiteDomain",
  "recoveredWebsiteUrl",
  "homepageFetchAttempted",
  "homepageFetchSucceeded",
  "homepageFetchFailed",
  "recoveredWebsiteFetchAttempted",
  "recoveredWebsiteFetchSucceeded",
  "recoveredWebsiteFetchFailed",
  "websiteEnrichmentFetchAttempted",
  "websiteEnrichmentFetchSucceeded",
  "websiteEnrichmentFetchFailed",
  "recoveredWebsiteEnrichmentFetchAttempted",
  "recoveredWebsiteEnrichmentFetchSucceeded",
  "recoveredWebsiteEnrichmentFetchFailed",
  "emailExtractionLiteralFound",
  "emailExtractionDeobfuscatedFound",
  "websiteEmailRejectedFormat",
  "websiteEmailsFound",
  "websiteEmailOtherEnrichmentFound",
  "websiteEmailSource",
  "websiteEmailAttributionComplete",
  "websiteContactPointsCreated",
  "websiteContactPointDuplicates",
  "websiteValidEmails",
  "websiteEligible",
  "websiteImported",
  "websiteAttributionStartedAt",
  "websiteAttributionCompletedAt",
] as const;

const RECOVERED_FETCH_KEYS = [
  "websiteOrigin",
  "recoveredWebsiteFetchAttempted",
  "recoveredWebsiteFetchSucceeded",
  "recoveredWebsiteFetchFailed",
  "recoveredWebsiteEnrichmentFetchAttempted",
  "recoveredWebsiteEnrichmentFetchSucceeded",
  "recoveredWebsiteEnrichmentFetchFailed",
  "websiteAttributionStartedAt",
  "websiteAttributionCompletedAt",
] as const;

const RECOVERED_EMAIL_KEYS = [
  "websiteOrigin",
  "emailExtractionLiteralFound",
  "emailExtractionDeobfuscatedFound",
  "websiteEmailRejectedFormat",
  "websiteEmailsFound",
  "websiteEmailOtherEnrichmentFound",
  "websiteEmailSource",
  "websiteEmailAttributionComplete",
  "websiteValidEmails",
  "websiteEligible",
  "websiteImported",
  "websiteAttributionStartedAt",
  "websiteAttributionCompletedAt",
] as const;

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export function buildWebsiteRecoveryAttributionQuery(input: WebsiteRecoveryAttributionQueryInput) {
  const periods = sql`(VALUES ${sql.join(input.periods.map((period) => sql`
    (${period.name}, ${period.start.toISOString()}::timestamptz, ${period.end.toISOString()}::timestamptz)
  `), sql`, `)})`;
  const recoveryKeys = textArray(RECOVERY_TELEMETRY_KEYS);
  const fetchKeys = textArray(RECOVERED_FETCH_KEYS);
  const emailKeys = textArray(RECOVERED_EMAIL_KEYS);
  const recoveryComplete = sql`scope.metrics ?& ${recoveryKeys}
    AND scope.metrics->>'websiteEmailAttributionComplete' = 'true'
    AND NULLIF(scope.metrics->>'websiteAttributionStartedAt', '') IS NOT NULL
    AND NULLIF(scope.metrics->>'websiteAttributionCompletedAt', '') IS NOT NULL
    AND scope.metrics->>'websiteOrigin' IN ('source', 'none', 'recovered')
    AND ((scope.metrics->>'websiteOrigin' = 'recovered'
      AND scope.metrics->>'websiteRecoveryStatus' = 'succeeded'
      AND NULLIF(scope.metrics->>'recoveredWebsiteDomain', '') IS NOT NULL
      AND NULLIF(scope.metrics->>'recoveredWebsiteUrl', '') IS NOT NULL)
      OR (scope.metrics->>'websiteOrigin' <> 'recovered'
        AND scope.metrics->>'websiteRecoveryStatus' <> 'succeeded'))`;
  const recoveredFetchComplete = sql`${recoveryComplete}
    AND scope.metrics ?& ${fetchKeys}
    AND (scope.metrics->>'websiteOrigin' <> 'recovered'
      OR NULLIF(scope.metrics->>'recoveredWebsiteDomain', '') IS NOT NULL)`;
  const recoveredEmailComplete = sql`${recoveryComplete}
    AND scope.metrics ?& ${emailKeys}
    AND (scope.metrics->>'websiteOrigin' IN ('source', 'none')
      OR (scope.metrics->>'websiteOrigin' = 'recovered'
        AND NULLIF(scope.metrics->>'recoveredWebsiteDomain', '') IS NOT NULL))`;

  return sql`
    WITH periods(name, start_at, end_at) AS ${periods},
    raw_scope AS (
      SELECT periods.name AS window, periods.end_at,
        raw.id AS raw_id, raw.campaign_id, raw.account_id, raw.engine_type,
        campaign.workspace_id, COALESCE(raw.processing_metrics, '{}'::jsonb) AS metrics,
        NULLIF(raw.processing_metrics->>'websiteAttributionStartedAt', '')::timestamptz AS attribution_started_at,
        NULLIF(raw.processing_metrics->>'websiteAttributionCompletedAt', '')::timestamptz AS attribution_completed_at
      FROM periods
      JOIN raw_candidates raw ON raw.discovered_at >= periods.start_at AND raw.discovered_at < periods.end_at
      JOIN campaigns campaign ON campaign.id = raw.campaign_id
        AND campaign.workspace_id = ${input.workspaceId}::uuid
    ),
    candidate_contact_points AS (
      SELECT scope.window, scope.raw_id, contact_point.id AS contact_point_id,
        contact_point.verification_status,
        membership.stage AS membership_stage,
        membership.selected_contact_point_id,
        contact_point.source_type,
        EXISTS (
          SELECT 1 FROM instantly_lead_imports imported
          WHERE imported.workspace_id = scope.workspace_id
            AND imported.account_id = scope.account_id
            AND imported.contact_point_id = contact_point.id
            AND imported.provider_campaign_id = ${input.targetProviderCampaignId}
            AND imported.status = 'instantly_added'
            AND imported.provider_lead_id IS NOT NULL
            AND imported.uploaded_at >= scope.attribution_completed_at
            AND imported.uploaded_at < scope.end_at
        ) AS imported
      FROM raw_scope scope
      JOIN contact_points contact_point ON contact_point.workspace_id = scope.workspace_id
        AND contact_point.account_id = scope.account_id
        AND contact_point.type = 'email'
        AND contact_point.source_type IN ('website', 'website_enrichment')
        AND NULLIF(TRIM(contact_point.normalized_value), '') IS NOT NULL
      LEFT JOIN campaign_memberships membership ON membership.campaign_id = scope.campaign_id
        AND membership.account_id = scope.account_id
        AND membership.selected_contact_point_id = contact_point.id
      WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND scope.attribution_started_at IS NOT NULL
        AND scope.attribution_completed_at IS NOT NULL
        AND contact_point.created_at >= scope.attribution_started_at
        AND contact_point.created_at <= scope.attribution_completed_at
        AND lower(CASE
          WHEN split_part(split_part(contact_point.source_url, '/', 3), ':', 1) ILIKE 'www.%'
            THEN substr(split_part(split_part(contact_point.source_url, '/', 3), ':', 1), 5)
          ELSE split_part(split_part(contact_point.source_url, '/', 3), ':', 1)
        END) = lower(scope.metrics->>'recoveredWebsiteDomain')
        AND NOT EXISTS (
          SELECT 1 FROM raw_candidates competing_raw
          JOIN campaigns competing_campaign ON competing_campaign.id = competing_raw.campaign_id
            AND competing_campaign.workspace_id = scope.workspace_id
          WHERE competing_raw.id <> scope.raw_id
            AND competing_raw.account_id = scope.account_id
            AND competing_raw.processing_metrics->>'websiteOrigin' = 'recovered'
            AND lower(competing_raw.processing_metrics->>'recoveredWebsiteDomain')
              = lower(scope.metrics->>'recoveredWebsiteDomain')
            AND contact_point.created_at >= NULLIF(competing_raw.processing_metrics->>'websiteAttributionStartedAt', '')::timestamptz
            AND contact_point.created_at <= NULLIF(competing_raw.processing_metrics->>'websiteAttributionCompletedAt', '')::timestamptz
        )
    ),
    candidate_contact_rollup AS (
      SELECT window, raw_id,
        BOOL_OR(verification_status = 'valid') AS has_valid_email,
        BOOL_OR(verification_status IN ('invalid', 'disposable', 'bounced')) AS has_invalid_email,
        BOOL_OR(verification_status IN ('unknown', 'unverified')) AS has_pending_email,
        BOOL_OR(membership_stage = 'ready' AND selected_contact_point_id = contact_point_id
          AND verification_status = 'valid') AS eligible,
        BOOL_OR(membership_stage = 'ready' AND selected_contact_point_id = contact_point_id
          AND verification_status = 'valid' AND imported) AS imported,
        CASE
          WHEN BOOL_OR(membership_stage IS NOT NULL AND selected_contact_point_id = contact_point_id
            AND source_type = 'website_enrichment') THEN 'other_enrichment'
          WHEN BOOL_OR(membership_stage IS NOT NULL AND selected_contact_point_id = contact_point_id
            AND source_type = 'website'
            AND COALESCE(NULLIF(scope_metrics.metrics->>'emailExtractionLiteralFound', '')::int, 0) > 0
            AND COALESCE(NULLIF(scope_metrics.metrics->>'emailExtractionDeobfuscatedFound', '')::int, 0) = 0) THEN 'literal'
          WHEN BOOL_OR(membership_stage IS NOT NULL AND selected_contact_point_id = contact_point_id
            AND source_type = 'website'
            AND COALESCE(NULLIF(scope_metrics.metrics->>'emailExtractionDeobfuscatedFound', '')::int, 0) > 0
            AND COALESCE(NULLIF(scope_metrics.metrics->>'emailExtractionLiteralFound', '')::int, 0) = 0) THEN 'deobfuscated'
          ELSE 'unattributed'
        END AS selected_email_source
      FROM candidate_contact_points
      JOIN raw_scope scope_metrics USING (window, raw_id)
      GROUP BY window, raw_id
    )
    SELECT scope.window, scope.engine_type AS engine,
      COUNT(*)::int AS raw_rows,
      COUNT(*) FILTER (WHERE scope.metrics ? 'websiteOrigin'
        OR scope.metrics ? 'websiteRecoveryAttempted')::int AS recovery_telemetry_rows,
      COUNT(*) FILTER (WHERE ${recoveryComplete})::int AS recovery_telemetry_complete_rows,
      COUNT(*) FILTER (WHERE ${recoveredFetchComplete})::int AS recovered_fetch_attribution_complete_rows,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete})::int AS recovered_email_attribution_complete_rows,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' IN ('none', 'recovered'))::int AS recovery_missing_website,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'source')::int AS source_website_rows,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered')::int AS recovered_website_rows,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'none')::int AS no_website_rows,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'websiteRecoveryAttempted', '')::int, 0))
        FILTER (WHERE ${recoveryComplete}), 0)::int AS recovery_attempted,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'websiteRecoverySucceeded', '')::int, 0))
        FILTER (WHERE ${recoveryComplete}), 0)::int AS recovery_succeeded,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'websiteRecoveryFailed', '')::int, 0))
        FILTER (WHERE ${recoveryComplete}), 0)::int AS recovery_failed,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchAttempted', '')::int, 0))
        FILTER (WHERE ${recoveredFetchComplete}), 0)::int AS recovered_fetch_attempted,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchSucceeded', '')::int, 0))
        FILTER (WHERE ${recoveredFetchComplete}), 0)::int AS recovered_fetch_succeeded,
      COALESCE(SUM(COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchFailed', '')::int, 0))
        FILTER (WHERE ${recoveredFetchComplete}), 0)::int AS recovered_fetch_failed,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(NULLIF(scope.metrics->>'websiteEmailsFound', '')::int, 0) > 0
        )::int AS recovered_email_found,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(contact_rollup.has_valid_email, false))::int AS recovered_valid_email,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(contact_rollup.eligible, false))::int AS recovered_eligible,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(contact_rollup.imported, false))::int AS recovered_instantly_added,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'none'
        AND scope.metrics->>'websiteRecoveryStatus' = 'not_applicable')::int AS loss_no_website_original,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'none'
        AND scope.metrics->>'websiteRecoveryStatus' IN ('not_attempted', 'blocked', 'budget_blocked')
        AND COALESCE(NULLIF(scope.metrics->>'websiteRecoveryAttempted', '')::int, 0) = 0)::int AS loss_recovery_not_attempted,
      COUNT(*) FILTER (WHERE ${recoveryComplete}
        AND scope.metrics->>'websiteOrigin' = 'none'
        AND scope.metrics->>'websiteRecoveryStatus' = 'failed'
        AND COALESCE(NULLIF(scope.metrics->>'websiteRecoveryAttempted', '')::int, 0) > 0)::int AS loss_recovery_failed,
      COUNT(*) FILTER (WHERE ${recoveredFetchComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchAttempted', '')::int, 0) > 0
        AND COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchSucceeded', '')::int, 0) = 0
        AND COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchFailed', '')::int, 0) > 0)::int AS loss_recovered_fetch_failed,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(NULLIF(scope.metrics->>'recoveredWebsiteFetchSucceeded', '')::int, 0) > 0
        AND COALESCE(NULLIF(scope.metrics->>'websiteEmailRejectedFormat', '')::int, 0) = 0
        AND COALESCE(NULLIF(scope.metrics->>'websiteEmailsFound', '')::int, 0) = 0)::int AS loss_recovered_fetch_no_email,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND ((COALESCE(NULLIF(scope.metrics->>'websiteEmailRejectedFormat', '')::int, 0) > 0
            AND COALESCE(NULLIF(scope.metrics->>'websiteEmailsFound', '')::int, 0) = 0)
          OR (COALESCE(NULLIF(scope.metrics->>'websiteEmailsFound', '')::int, 0) > 0
            AND COALESCE(contact_rollup.has_invalid_email, false)))
        AND NOT COALESCE(contact_rollup.has_valid_email, false)
        AND NOT COALESCE(contact_rollup.has_pending_email, false))::int AS loss_recovered_email_invalid,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(contact_rollup.has_valid_email, false)
        AND NOT COALESCE(contact_rollup.eligible, false))::int AS loss_recovered_valid_not_eligible,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND COALESCE(contact_rollup.eligible, false)
        AND NOT COALESCE(contact_rollup.imported, false))::int AS loss_recovered_eligible_not_imported,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND contact_rollup.selected_email_source = 'literal')::int AS selected_email_literal,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND contact_rollup.selected_email_source = 'deobfuscated')::int AS selected_email_deobfuscated,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND contact_rollup.selected_email_source = 'other_enrichment')::int AS selected_email_other_enrichment,
      COUNT(*) FILTER (WHERE ${recoveredEmailComplete}
        AND scope.metrics->>'websiteOrigin' = 'recovered'
        AND contact_rollup.selected_email_source = 'unattributed')::int AS selected_email_unattributed
    FROM raw_scope scope
    LEFT JOIN candidate_contact_rollup contact_rollup ON contact_rollup.window = scope.window
      AND contact_rollup.raw_id = scope.raw_id
    GROUP BY scope.window, scope.engine_type
  `;
}

export function buildDeadLetterAggregateQuery(workspaceId: string, now: Date) {
  return sql`
    WITH dead_letters AS (
      SELECT dead_letter.source_table AS queue_type,
        COALESCE(raw.engine_type, campaign.engine_type, 'unknown') AS engine,
        dead_letter.last_error,
        dead_letter.created_at
      FROM dead_letter_jobs dead_letter
      JOIN campaigns campaign ON campaign.id = dead_letter.campaign_id
        AND campaign.workspace_id = ${workspaceId}::uuid
      LEFT JOIN processing_jobs processing_job ON dead_letter.source_table = 'processing_jobs'
        AND processing_job.id = dead_letter.source_job_id
      LEFT JOIN raw_candidates raw ON raw.id = CASE
        WHEN processing_job.payload->>'rawCandidateId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (processing_job.payload->>'rawCandidateId')::uuid
        ELSE NULL
      END
      UNION ALL
      SELECT 'verification_jobs' AS queue_type,
        COALESCE(source.engine_type, 'unknown') AS engine,
        verification_job.last_error,
        verification_job.created_at
      FROM verification_jobs verification_job
      JOIN contact_points contact_point ON contact_point.id = verification_job.contact_point_id
        AND contact_point.workspace_id = verification_job.workspace_id
      LEFT JOIN LATERAL (
        SELECT raw.engine_type
        FROM raw_candidates raw
        JOIN campaigns source_campaign ON source_campaign.id = raw.campaign_id
          AND source_campaign.workspace_id = verification_job.workspace_id
        WHERE raw.account_id = contact_point.account_id
        ORDER BY raw.discovered_at DESC
        LIMIT 1
      ) source ON TRUE
      WHERE verification_job.workspace_id = ${workspaceId}::uuid
        AND verification_job.status = 'dead_letter'
      UNION ALL
      SELECT 'intelligence_jobs' AS queue_type,
        campaign.engine_type AS engine,
        intelligence_job.last_error,
        intelligence_job.created_at
      FROM intelligence_jobs intelligence_job
      JOIN campaigns campaign ON campaign.id = intelligence_job.campaign_id
        AND campaign.workspace_id = ${workspaceId}::uuid
      WHERE intelligence_job.status = 'dead_letter'
    ), classified AS (
      SELECT queue_type, engine,
        CASE
          WHEN last_error ~* '(42p18|could not determine data type|indeterminate datatype)' THEN 'reservation_parameter_typing'
          WHEN last_error ~* '(uri malformed|malformed uri|invalid uri|malformed url)' THEN 'malformed_uri'
          WHEN last_error ~* '(timeout|timed out|deadline exceeded|abort)' THEN 'timeout_or_deadline'
          WHEN last_error ~* '(billing|payment|usage limit|quota|cost limit|budget exceeded)' THEN 'provider_billing_or_quota'
          WHEN last_error ~* '(out of memory|heap|memory limit)' THEN 'provider_memory'
          WHEN last_error ~* '(unauthorized|forbidden|invalid credential|authentication)' THEN 'provider_authentication'
          WHEN last_error ~* '(apify|actor|serper|provider)' THEN 'other_provider_failure'
          ELSE 'other_or_unclassified'
        END AS failure_class,
        CASE
          WHEN created_at >= ${now.toISOString()}::timestamptz - INTERVAL '24 hours' THEN 'lt_24h'
          WHEN created_at >= ${now.toISOString()}::timestamptz - INTERVAL '3 days' THEN '1_3d'
          WHEN created_at >= ${now.toISOString()}::timestamptz - INTERVAL '7 days' THEN '3_7d'
          ELSE 'gt_7d'
        END AS age_bucket
      FROM dead_letters
    )
    SELECT queue_type, engine, failure_class, age_bucket, COUNT(*)::int AS count
    FROM classified
    GROUP BY queue_type, engine, failure_class, age_bucket
  `;
}