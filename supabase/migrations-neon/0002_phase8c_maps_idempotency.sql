-- PHASE 8C: preserve unknown country data and prevent repeated Maps ingestion.

ALTER TABLE accounts ALTER COLUMN country_code DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_candidates_campaign_engine_external
  ON raw_candidates (campaign_id, engine_type, source_external_id)
  WHERE source_external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_sources_external
  ON account_sources (account_id, source_provider, source_external_id)
  WHERE source_external_id IS NOT NULL;