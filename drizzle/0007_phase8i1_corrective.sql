DROP INDEX IF EXISTS "uq_rebalance_decisions_idempotency";

CREATE UNIQUE INDEX "uq_rebalance_decisions_idempotency"
  ON "rebalance_decisions" ("idempotency_key");

ALTER TABLE "raw_candidates"
  ADD COLUMN IF NOT EXISTS "search_seed_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "provider_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "account_id" uuid;

ALTER TABLE "raw_candidates"
  ADD CONSTRAINT "raw_candidates_search_seed_run_id_fk"
    FOREIGN KEY ("search_seed_run_id") REFERENCES "search_seed_runs"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "raw_candidates_provider_run_id_fk"
    FOREIGN KEY ("provider_run_id") REFERENCES "provider_runs"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "raw_candidates_account_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_raw_candidates_search_seed_run" ON "raw_candidates" ("search_seed_run_id");
CREATE INDEX IF NOT EXISTS "idx_raw_candidates_provider_run" ON "raw_candidates" ("provider_run_id");
CREATE INDEX IF NOT EXISTS "idx_raw_candidates_account" ON "raw_candidates" ("account_id");

ALTER TABLE "search_seed_runs"
  ADD COLUMN IF NOT EXISTS "qualification_finalized_at" timestamptz;