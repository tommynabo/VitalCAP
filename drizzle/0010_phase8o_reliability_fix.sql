DROP INDEX "uq_raw_candidates_campaign_engine_external";--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD COLUMN "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
UPDATE "raw_candidates" SET "source_fingerprint" = COALESCE("source_external_id", id::text);--> statement-breakpoint
ALTER TABLE "raw_candidates" ALTER COLUMN "source_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "ingestion_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "ingestion_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "last_ingestion_error" text;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "seed_run_id" uuid;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "system_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "system_pause_reason" text;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "system_paused_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_raw_candidates_campaign_engine_fingerprint" ON "raw_candidates" USING btree ("campaign_id","engine_type","source_fingerprint");