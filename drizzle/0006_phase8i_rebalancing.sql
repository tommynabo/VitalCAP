ALTER TABLE "rebalance_decisions"
  ADD COLUMN IF NOT EXISTS "from_campaign_id" uuid,
  ADD COLUMN IF NOT EXISTS "to_campaign_id" uuid,
  ADD COLUMN IF NOT EXISTS "metric_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_rebalance_decisions_idempotency"
  ON "rebalance_decisions" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;