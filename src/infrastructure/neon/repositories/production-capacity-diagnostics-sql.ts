import { sql } from "drizzle-orm";

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