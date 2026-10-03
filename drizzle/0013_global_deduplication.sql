ALTER TABLE outreach_queue
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS normalized_email text;
--> statement-breakpoint
UPDATE outreach_queue AS queue
SET workspace_id = campaign.workspace_id,
    normalized_email = CASE WHEN queue.channel = 'email' THEN lower(contact_point.normalized_value) ELSE NULL END
FROM campaigns AS campaign, contact_points AS contact_point
WHERE campaign.id = queue.campaign_id AND contact_point.id = queue.contact_point_id;
--> statement-breakpoint
ALTER TABLE outreach_queue ALTER COLUMN workspace_id SET NOT NULL;
--> statement-breakpoint

-- Preserve source evidence while collapsing exact duplicate source identities.
WITH duplicate_sources AS (
  SELECT
    account_id,
    source_type,
    source_provider,
    COALESCE(source_external_id, source_url, '') AS source_identity,
    (array_agg(id ORDER BY discovered_at, id))[1] AS canonical_id,
    jsonb_agg(
      jsonb_build_object(
        'sourceId', id,
        'sourceExternalId', source_external_id,
        'sourceUrl', source_url,
        'rawSnapshot', raw_snapshot,
        'discoveredAt', discovered_at
      ) ORDER BY discovered_at, id
    ) AS evidence
  FROM account_sources
  GROUP BY account_id, source_type, source_provider, COALESCE(source_external_id, source_url, '')
  HAVING count(*) > 1
)
UPDATE account_sources AS source
SET raw_snapshot = jsonb_build_object('_deduplicatedEvidence', duplicate_sources.evidence)
FROM duplicate_sources
WHERE source.id = duplicate_sources.canonical_id;
--> statement-breakpoint

WITH ranked_sources AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY account_id, source_type, source_provider, COALESCE(source_external_id, source_url, '')
      ORDER BY discovered_at, id
    ) AS source_rank
  FROM account_sources
)
DELETE FROM account_sources AS source
USING ranked_sources
WHERE source.id = ranked_sources.id AND ranked_sources.source_rank > 1;
--> statement-breakpoint

DROP INDEX IF EXISTS uq_account_sources_external;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_sources_identity
  ON account_sources (account_id, source_type, source_provider, (COALESCE(source_external_id, source_url, '')));
--> statement-breakpoint

DROP INDEX IF EXISTS uq_contact_points_normalized_value;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_points_account_normalized_value
  ON contact_points (workspace_id, account_id, type, normalized_value);
--> statement-breakpoint

-- Keep every prior queue row and its events; cancel only the later duplicate active entry.
WITH ranked_active_outreach AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY account_id ORDER BY created_at, id) AS queue_rank
  FROM outreach_queue
  WHERE state IN ('queued', 'scheduled', 'provider_submitted')
)
UPDATE outreach_queue AS queue
SET state = 'canceled', updated_at = now()
FROM ranked_active_outreach
WHERE queue.id = ranked_active_outreach.id AND ranked_active_outreach.queue_rank > 1;
--> statement-breakpoint

WITH ranked_active_email_outreach AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY workspace_id, normalized_email ORDER BY created_at, id) AS queue_rank
  FROM outreach_queue
  WHERE normalized_email IS NOT NULL
    AND state IN ('queued', 'scheduled', 'provider_submitted')
)
UPDATE outreach_queue AS queue
SET state = 'canceled', updated_at = now()
FROM ranked_active_email_outreach
WHERE queue.id = ranked_active_email_outreach.id AND ranked_active_email_outreach.queue_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_active_account
  ON outreach_queue (account_id)
  WHERE state IN ('queued', 'scheduled', 'provider_submitted');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_active_workspace_email
  ON outreach_queue (workspace_id, normalized_email)
  WHERE normalized_email IS NOT NULL AND state IN ('queued', 'scheduled', 'provider_submitted');
