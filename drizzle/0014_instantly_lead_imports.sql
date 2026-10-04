CREATE TABLE "instantly_import_locks" (
	"provider_campaign_id" text PRIMARY KEY NOT NULL,
	"lock_token" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instantly_lead_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_campaign_id" uuid NOT NULL,
	"contact_id" uuid,
	"contact_point_id" uuid NOT NULL,
	"provider_campaign_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'eligible' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"locked_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_error" text,
	"provider_lead_id" text,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instantly_lead_imports" ADD CONSTRAINT "instantly_lead_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instantly_lead_imports" ADD CONSTRAINT "instantly_lead_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instantly_lead_imports" ADD CONSTRAINT "instantly_lead_imports_source_campaign_id_campaigns_id_fk" FOREIGN KEY ("source_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instantly_lead_imports" ADD CONSTRAINT "instantly_lead_imports_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instantly_lead_imports" ADD CONSTRAINT "instantly_lead_imports_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instantly_import_identity" ON "instantly_lead_imports" USING btree ("workspace_id","account_id","contact_point_id","provider_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instantly_import_idempotency" ON "instantly_lead_imports" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instantly_import_email" ON "instantly_lead_imports" USING btree ("workspace_id","normalized_email","provider_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instantly_import_active_account" ON "instantly_lead_imports" USING btree ("workspace_id","account_id","provider_campaign_id") WHERE "instantly_lead_imports"."status" in ('eligible', 'instantly_queued', 'instantly_added', 'skipped_existing', 'failed', 'deferred');--> statement-breakpoint
CREATE INDEX "idx_instantly_import_dispatch" ON "instantly_lead_imports" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_instantly_import_workspace_status" ON "instantly_lead_imports" USING btree ("workspace_id","status");