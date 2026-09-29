ALTER TABLE "verification_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD COLUMN "cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD COLUMN "normalized_email" text;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint

ALTER TABLE "prospect_analyses" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "prospect_analyses" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX "uq_compliance_decisions_current" ON "compliance_decisions" USING btree ("campaign_id","contact_point_id","channel") WHERE superseded_at IS NULL;--> statement-breakpoint
