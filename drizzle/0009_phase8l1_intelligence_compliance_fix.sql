ALTER TABLE "intelligence_jobs" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "intelligence_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_intelligence_jobs_status" ON "intelligence_jobs" USING btree ("status");