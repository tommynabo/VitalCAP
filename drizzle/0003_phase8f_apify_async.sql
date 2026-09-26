-- PHASE 8F: durable asynchronous Apify Actor lifecycle.
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS seed_id uuid;
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS ingested_at timestamptz;
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS error text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_runs_request_key ON provider_runs (request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_runs_async_status ON provider_runs (provider, status, started_at);
