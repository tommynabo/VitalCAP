CREATE TABLE "email_verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_point_id" uuid NOT NULL,
	"normalized_email" text NOT NULL,
	"provider" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"status" text NOT NULL,
	"provider_raw_code" text,
	"checked_at" timestamp with time zone NOT NULL,
	"cost_usd" numeric DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_verification_jobs_unique";--> statement-breakpoint
ALTER TABLE "email_verification_events" ADD CONSTRAINT "email_verification_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_events" ADD CONSTRAINT "email_verification_events_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_verification_events_contact" ON "email_verification_events" USING btree ("workspace_id","contact_point_id","checked_at");--> statement-breakpoint
CREATE INDEX "idx_email_verification_events_email" ON "email_verification_events" USING btree ("workspace_id","normalized_email","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_verification_jobs_unique" ON "verification_jobs" USING btree ("workspace_id","idempotency_key") WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing');