CREATE TABLE "intelligence_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"fit_score" integer,
	"fit_tier" text,
	"confidence" numeric,
	"qualified" boolean,
	"needs_human_review" boolean,
	"analysis_json" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_usd" numeric,
	"provider_request_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "intelligence_jobs" ADD CONSTRAINT "intelligence_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_jobs" ADD CONSTRAINT "intelligence_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_jobs" ADD CONSTRAINT "intelligence_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_analyses" ADD CONSTRAINT "prospect_analyses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_analyses" ADD CONSTRAINT "prospect_analyses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_analyses" ADD CONSTRAINT "prospect_analyses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_intelligence_jobs_idempotency" ON "intelligence_jobs" USING btree ("campaign_id","account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_intelligence_jobs_locked_at" ON "intelligence_jobs" USING btree ("locked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prospect_analyses_logical" ON "prospect_analyses" USING btree ("campaign_id","account_id","prompt_version","input_hash");--> statement-breakpoint
CREATE INDEX "idx_prospect_analyses_workspace" ON "prospect_analyses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_prospect_analyses_account" ON "prospect_analyses" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_prospect_analyses_status" ON "prospect_analyses" USING btree ("status");