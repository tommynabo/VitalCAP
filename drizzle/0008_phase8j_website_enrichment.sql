CREATE TABLE "autopilot_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"emergency_stopped" boolean DEFAULT false NOT NULL,
	"global_daily_target" integer DEFAULT 25 NOT NULL,
	"target_metric" text DEFAULT 'qualified' NOT NULL,
	"timezone" text DEFAULT 'Europe/Madrid' NOT NULL,
	"operating_start_hour" integer,
	"operating_end_hour" integer,
	"max_daily_apify_spend_usd" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"normalized_domain" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"content_hash" text,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"error" text,
	"next_refresh_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "website_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"normalized_domain" text NOT NULL,
	"source_url" text NOT NULL,
	"evidence_type" text NOT NULL,
	"value" text NOT NULL,
	"snippet" text,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD COLUMN "search_seed_run_id" uuid;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD COLUMN "provider_run_id" uuid;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "search_seed_runs" ADD COLUMN "qualification_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "seed_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "rebalance_decisions" ADD COLUMN "from_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "rebalance_decisions" ADD COLUMN "to_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "rebalance_decisions" ADD COLUMN "metric_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rebalance_decisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_enrichments" ADD CONSTRAINT "website_enrichments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_enrichments" ADD CONSTRAINT "website_enrichments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_evidence" ADD CONSTRAINT "website_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_evidence" ADD CONSTRAINT "website_evidence_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_website_enrichments_workspace" ON "website_enrichments" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_website_enrichments_domain" ON "website_enrichments" USING btree ("workspace_id","normalized_domain");--> statement-breakpoint
CREATE INDEX "idx_website_enrichments_account" ON "website_enrichments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_website_evidence_account" ON "website_evidence" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_website_evidence_idempotency" ON "website_evidence" USING btree ("account_id","source_url","evidence_type","content_hash");--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD CONSTRAINT "raw_candidates_search_seed_run_id_search_seed_runs_id_fk" FOREIGN KEY ("search_seed_run_id") REFERENCES "public"."search_seed_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD CONSTRAINT "raw_candidates_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD CONSTRAINT "raw_candidates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_runs_request_key" ON "provider_runs" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rebalance_decisions_idempotency" ON "rebalance_decisions" USING btree ("idempotency_key");