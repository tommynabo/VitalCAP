CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_merge_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surviving_account_id" uuid NOT NULL,
	"merged_account_id" uuid NOT NULL,
	"matched_signal" text NOT NULL,
	"confidence" numeric NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_provider" text NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"raw_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"business_type" text NOT NULL,
	"country_code" text,
	"region" text,
	"province" text,
	"city" text,
	"postal_code" text,
	"address_line" text,
	"normalized_address" text,
	"latitude" double precision,
	"longitude" double precision,
	"phone" text,
	"normalized_phone" text,
	"website_url" text,
	"normalized_domain" text,
	"google_place_id" text,
	"maps_url" text,
	"rating" numeric,
	"review_count" integer,
	"fit_score" numeric,
	"fit_tier" text DEFAULT 'unscored' NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"label" text,
	"is_generic" boolean DEFAULT false NOT NULL,
	"is_personal_or_named" boolean DEFAULT false NOT NULL,
	"priority_score" numeric DEFAULT 0 NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verification_provider" text,
	"verification_checked_at" timestamp with time zone,
	"channel_eligibility" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"source_url" text,
	"source_type" text,
	"last_contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"job_title" text,
	"role_type" text DEFAULT 'unknown' NOT NULL,
	"is_decision_maker" boolean DEFAULT false NOT NULL,
	"seniority" text DEFAULT 'unknown' NOT NULL,
	"linkedin_url" text,
	"source_confidence" numeric DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"selected_contact_point_id" uuid,
	"stage" text DEFAULT 'discovered' NOT NULL,
	"rejection_reason" text,
	"ready_at" timestamp with time zone,
	"contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"country_code" text DEFAULT 'ES' NOT NULL,
	"engine_type" text NOT NULL,
	"engine_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_soft_target" integer DEFAULT 50 NOT NULL,
	"minimum_fit_score" numeric,
	"outreach_profile_id" uuid,
	"autopilot_enabled" boolean DEFAULT false NOT NULL,
	"desired_channel_mix" jsonb DEFAULT '{"email":50,"sms":50}'::jsonb NOT NULL,
	"time_zone" text DEFAULT 'Europe/Madrid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"company" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"primary_cta" text NOT NULL,
	"booking_url" text NOT NULL,
	"approved_commercial_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_product_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"objection_guidance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tone_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"idempotency_key" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"idempotency_key" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discovery_job_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"engine_type" text NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_seed_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"raw_count" integer DEFAULT 0 NOT NULL,
	"unique_count" integer DEFAULT 0 NOT NULL,
	"ready_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "search_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"engine_type" text NOT NULL,
	"query" text NOT NULL,
	"geography" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"total_raw" integer DEFAULT 0 NOT NULL,
	"total_unique" integer DEFAULT 0 NOT NULL,
	"total_ready" integer DEFAULT 0 NOT NULL,
	"yield_rate" numeric DEFAULT 0 NOT NULL,
	"exhaustion_score" numeric DEFAULT 0 NOT NULL,
	"next_eligible_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dead_letter_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_table" text NOT NULL,
	"source_job_id" uuid NOT NULL,
	"campaign_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer NOT NULL,
	"last_error" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sending_domain_id" uuid NOT NULL,
	"email" text NOT NULL,
	"daily_capacity" integer DEFAULT 0 NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"bounce_rate" numeric DEFAULT 0 NOT NULL,
	"reply_rate" numeric DEFAULT 0 NOT NULL,
	"health_score" numeric DEFAULT 0 NOT NULL,
	"paused_reason" text
);
--> statement-breakpoint
CREATE TABLE "outreach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outreach_queue_item_id" uuid NOT NULL,
	"state" text NOT NULL,
	"provider_event_id" text,
	"payload_hash" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" text DEFAULT 'send_outreach' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"idempotency_key" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_error" text,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"contact_point_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"priority" numeric DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"state" text DEFAULT 'queued' NOT NULL,
	"delivery_mode" text DEFAULT 'dry_run' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sending_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'missing_configuration' NOT NULL,
	"warmup_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_point_id" uuid,
	"account_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"channel" text NOT NULL,
	"provider_message_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"campaign_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"provider_thread_id" text,
	"state" text DEFAULT 'new' NOT NULL,
	"latest_intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"booking_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setter_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_message_id" uuid NOT NULL,
	"language" text NOT NULL,
	"branch" text NOT NULL,
	"intent_summary" text NOT NULL,
	"confidence" numeric NOT NULL,
	"draft" text NOT NULL,
	"needs_human" boolean DEFAULT true NOT NULL,
	"reason_for_human" text,
	"detected_facts_requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_next_action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setter_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_message_id" uuid NOT NULL,
	"predicted_branch" text NOT NULL,
	"corrected_branch" text,
	"ai_draft" text NOT NULL,
	"corrected_text" text,
	"decision" text NOT NULL,
	"reason_category" text,
	"note" text,
	"meeting_outcome" text,
	"qualified" boolean,
	"lost_reason" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warm_followup_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pause_reason" text,
	"next_followup_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"external_run_id" text,
	"external_dataset_id" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"items_requested" integer DEFAULT 0 NOT NULL,
	"items_returned" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebalance_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_engine" text,
	"to_engine" text NOT NULL,
	"amount" numeric NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_merge_records" ADD CONSTRAINT "account_merge_records_surviving_account_id_accounts_id_fk" FOREIGN KEY ("surviving_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_merge_records" ADD CONSTRAINT "account_merge_records_merged_account_id_accounts_id_fk" FOREIGN KEY ("merged_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sources" ADD CONSTRAINT "account_sources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_selected_contact_point_id_contact_points_id_fk" FOREIGN KEY ("selected_contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD CONSTRAINT "raw_candidates_discovery_job_id_discovery_jobs_id_fk" FOREIGN KEY ("discovery_job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_candidates" ADD CONSTRAINT "raw_candidates_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_seed_runs" ADD CONSTRAINT "search_seed_runs_seed_id_search_seeds_id_fk" FOREIGN KEY ("seed_id") REFERENCES "public"."search_seeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_seeds" ADD CONSTRAINT "search_seeds_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sending_domain_id_sending_domains_id_fk" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_outreach_queue_item_id_outreach_queue_id_fk" FOREIGN KEY ("outreach_queue_item_id") REFERENCES "public"."outreach_queue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setter_drafts" ADD CONSTRAINT "setter_drafts_conversation_message_id_conversation_messages_id_fk" FOREIGN KEY ("conversation_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setter_feedback" ADD CONSTRAINT "setter_feedback_conversation_message_id_conversation_messages_id_fk" FOREIGN KEY ("conversation_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warm_followup_queue" ADD CONSTRAINT "warm_followup_queue_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebalance_decisions" ADD CONSTRAINT "rebalance_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_members_workspace_user" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_merge_records_surviving" ON "account_merge_records" USING btree ("surviving_account_id");--> statement-breakpoint
CREATE INDEX "idx_account_merge_records_merged" ON "account_merge_records" USING btree ("merged_account_id");--> statement-breakpoint
CREATE INDEX "idx_account_sources_account" ON "account_sources" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_sources_external" ON "account_sources" USING btree ("account_id","source_provider","source_external_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_workspace" ON "accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_status" ON "accounts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_accounts_place_id" ON "accounts" USING btree ("workspace_id","google_place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_accounts_normalized_domain" ON "accounts" USING btree ("workspace_id","normalized_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_accounts_normalized_phone" ON "accounts" USING btree ("workspace_id","normalized_phone");--> statement-breakpoint
CREATE INDEX "idx_accounts_name_postal" ON "accounts" USING btree ("workspace_id","normalized_name","postal_code");--> statement-breakpoint
CREATE INDEX "idx_accounts_name_address" ON "accounts" USING btree ("workspace_id","normalized_name","normalized_address");--> statement-breakpoint
CREATE INDEX "idx_contact_points_workspace" ON "contact_points" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_contact_points_account" ON "contact_points" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_contact_points_contact" ON "contact_points" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contact_points_normalized_value" ON "contact_points" USING btree ("workspace_id","type","normalized_value");--> statement-breakpoint
CREATE INDEX "idx_contacts_workspace" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_account" ON "contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_account_fullname" ON "contacts" USING btree ("account_id","full_name");--> statement-breakpoint
CREATE INDEX "idx_campaign_memberships_campaign" ON "campaign_memberships" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_memberships_account" ON "campaign_memberships" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_memberships_stage" ON "campaign_memberships" USING btree ("campaign_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_memberships_campaign_account" ON "campaign_memberships" USING btree ("campaign_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_workspace" ON "campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_status" ON "campaigns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_offers_workspace" ON "offers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_discovery_jobs_campaign" ON "discovery_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_discovery_jobs_dispatch" ON "discovery_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_discovery_jobs_idempotency_inflight" ON "discovery_jobs" USING btree ("idempotency_key") WHERE "discovery_jobs"."idempotency_key" is not null and "discovery_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_campaign" ON "processing_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_dispatch" ON "processing_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_processing_jobs_idempotency_inflight" ON "processing_jobs" USING btree ("idempotency_key") WHERE "processing_jobs"."idempotency_key" is not null and "processing_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_raw_candidates_job" ON "raw_candidates" USING btree ("discovery_job_id");--> statement-breakpoint
CREATE INDEX "idx_raw_candidates_campaign" ON "raw_candidates" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_raw_candidates_campaign_engine_external" ON "raw_candidates" USING btree ("campaign_id","engine_type","source_external_id") WHERE "raw_candidates"."source_external_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_search_seed_runs_seed" ON "search_seed_runs" USING btree ("seed_id");--> statement-breakpoint
CREATE INDEX "idx_search_seeds_campaign" ON "search_seeds" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dead_letter_jobs_source_job" ON "dead_letter_jobs" USING btree ("source_table","source_job_id");--> statement-breakpoint
CREATE INDEX "idx_dead_letter_jobs_source" ON "dead_letter_jobs" USING btree ("source_table","source_job_id");--> statement-breakpoint
CREATE INDEX "idx_dead_letter_jobs_created_at" ON "dead_letter_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_mailboxes_sending_domain" ON "mailboxes" USING btree ("sending_domain_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_events_queue_item" ON "outreach_events" USING btree ("outreach_queue_item_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_events_state" ON "outreach_events" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outreach_events_provider_event_id" ON "outreach_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_queue_campaign" ON "outreach_queue" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_queue_dispatch" ON "outreach_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outreach_queue_account" ON "outreach_queue" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_queue_dedup_key" ON "outreach_queue" USING btree ("contact_point_id","campaign_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outreach_queue_idempotency_inflight" ON "outreach_queue" USING btree ("idempotency_key") WHERE "outreach_queue"."idempotency_key" is not null and "outreach_queue"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_suppression_entries_workspace" ON "suppression_entries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_suppression_entries_contact_point" ON "suppression_entries" USING btree ("contact_point_id");--> statement-breakpoint
CREATE INDEX "idx_suppression_entries_account" ON "suppression_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_conversation" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_workspace" ON "conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_account" ON "conversations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_campaign" ON "conversations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_state" ON "conversations" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "idx_meetings_conversation" ON "meetings" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_setter_drafts_conversation_message" ON "setter_drafts" USING btree ("conversation_message_id");--> statement-breakpoint
CREATE INDEX "idx_setter_feedback_conversation_message" ON "setter_feedback" USING btree ("conversation_message_id");--> statement-breakpoint
CREATE INDEX "idx_warm_followup_queue_conversation" ON "warm_followup_queue" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_warm_followup_queue_dispatch" ON "warm_followup_queue" USING btree ("status","next_followup_at");--> statement-breakpoint
CREATE INDEX "idx_provider_runs_workspace" ON "provider_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_provider_runs_campaign" ON "provider_runs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_provider_runs_provider" ON "provider_runs" USING btree ("provider","started_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_workspace" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_rebalance_decisions_workspace" ON "rebalance_decisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_cron_runs_route_started" ON "cron_runs" USING btree ("route","started_at");