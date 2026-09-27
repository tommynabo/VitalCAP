CREATE TABLE "campaign_provider_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_campaign_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_point_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"decision" text NOT NULL,
	"eligibility_before" text,
	"eligibility_after" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"policy_version" text NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"normalized_email" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"provider_raw_code" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"cost" numeric,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_point_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_provider_mappings" ADD CONSTRAINT "campaign_provider_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_provider_mappings" ADD CONSTRAINT "campaign_provider_mappings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_provider_mappings_unique" ON "campaign_provider_mappings" USING btree ("campaign_id","provider");--> statement-breakpoint
CREATE INDEX "idx_compliance_decisions_workspace" ON "compliance_decisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_decisions_campaign" ON "compliance_decisions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_decisions_contact_point" ON "compliance_decisions" USING btree ("contact_point_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_decisions_active" ON "compliance_decisions" USING btree ("workspace_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_verifications_cache" ON "email_verifications" USING btree ("workspace_id","normalized_email","provider");--> statement-breakpoint
CREATE INDEX "idx_email_verifications_email" ON "email_verifications" USING btree ("normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_verification_jobs_unique" ON "verification_jobs" USING btree ("contact_point_id","provider") WHERE status IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_verification_jobs_unlocked" ON "verification_jobs" USING btree ("workspace_id") WHERE locked_at IS NULL AND status = 'pending';