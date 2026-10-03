CREATE TABLE "setter_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "setter_drafts" ADD COLUMN "provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "setter_feedback" ADD COLUMN "final_text" text;
--> statement-breakpoint
ALTER TABLE "setter_webhook_events" ADD CONSTRAINT "setter_webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setter_webhook_events_provider_event" ON "setter_webhook_events" USING btree ("provider","provider_event_id");
--> statement-breakpoint
CREATE INDEX "idx_setter_webhook_events_provider_message" ON "setter_webhook_events" USING btree ("provider","provider_message_id");
--> statement-breakpoint
CREATE INDEX "idx_setter_webhook_events_status" ON "setter_webhook_events" USING btree ("status","received_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_messages_provider_message" ON "conversation_messages" USING btree ("provider_message_id") WHERE "conversation_messages"."provider_message_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_workspace_provider_thread" ON "conversations" USING btree ("workspace_id","provider_thread_id") WHERE "conversations"."provider_thread_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setter_drafts_conversation_message" ON "setter_drafts" USING btree ("conversation_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setter_feedback_conversation_message" ON "setter_feedback" USING btree ("conversation_message_id");