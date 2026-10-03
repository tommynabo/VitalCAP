DROP INDEX "uq_email_verifications_cache";--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "pipeline_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_verifications_cache" ON "email_verifications" USING btree ("workspace_id","normalized_email","provider","pipeline_version");