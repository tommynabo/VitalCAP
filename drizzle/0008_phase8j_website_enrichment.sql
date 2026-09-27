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
	"normalized_value" text NOT NULL,
	"snippet" text,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "website_enrichments" ADD CONSTRAINT "website_enrichments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_enrichments" ADD CONSTRAINT "website_enrichments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_evidence" ADD CONSTRAINT "website_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_evidence" ADD CONSTRAINT "website_evidence_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_website_enrichments_workspace" ON "website_enrichments" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_website_enrichments_account_domain" ON "website_enrichments" USING btree ("account_id","normalized_domain");--> statement-breakpoint
CREATE INDEX "idx_website_enrichments_account" ON "website_enrichments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_website_evidence_account" ON "website_evidence" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_website_evidence_idempotency" ON "website_evidence" USING btree ("account_id","source_url","evidence_type","normalized_value");