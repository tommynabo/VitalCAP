ALTER TABLE "raw_candidates" ADD COLUMN "source_fingerprint_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "ingestion_claim_token" text;--> statement-breakpoint
CREATE INDEX "idx_provider_runs_seed_run" ON "provider_runs" USING btree ("seed_run_id");--> statement-breakpoint

-- Backfill source_fingerprint with canonical rules
UPDATE "raw_candidates"
SET "source_fingerprint" = 'place:v1:' || "source_external_id", "source_fingerprint_version" = 'v1'
WHERE "source_external_id" IS NOT NULL AND "source_fingerprint" NOT LIKE 'place:v1:%';--> statement-breakpoint

UPDATE "raw_candidates"
SET "source_fingerprint" = 'url:v1:' || "source_url", "source_fingerprint_version" = 'v1'
WHERE "source_external_id" IS NULL AND "source_url" IS NOT NULL AND "source_fingerprint" NOT LIKE 'url:v1:%';--> statement-breakpoint

-- Backfill qualified_at using the most conservative historical timestamp
UPDATE "campaign_memberships"
SET "qualified_at" = coalesce("ready_at", "updated_at")
WHERE "stage" IN ('qualified', 'contact_selected', 'ready', 'contacted') AND "qualified_at" IS NULL;--> statement-breakpoint