CREATE TABLE IF NOT EXISTS "setter_webhook_events" (
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
ALTER TABLE "setter_drafts" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "setter_feedback" ADD COLUMN IF NOT EXISTS "final_text" text;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "setter_webhook_events" AS event
		LEFT JOIN "workspaces" AS workspace ON workspace."id" = event."workspace_id"
		WHERE event."workspace_id" IS NOT NULL AND workspace."id" IS NULL
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: setter_webhook_events contains orphan workspace_id values; reconcile them before retrying';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'setter_webhook_events_workspace_id_workspaces_id_fk'
			AND conrelid = 'setter_webhook_events'::regclass
	) THEN
		ALTER TABLE "setter_webhook_events"
			ADD CONSTRAINT "setter_webhook_events_workspace_id_workspaces_id_fk"
			FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "setter_webhook_events"
		GROUP BY "provider", "provider_event_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: duplicate webhook provider/event IDs exist; reconcile them before retrying';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "conversation_messages"
		WHERE "provider_message_id" IS NOT NULL
		GROUP BY "provider_message_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: duplicate conversation provider_message_id values exist; reconcile them before retrying';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "conversations"
		WHERE "provider_thread_id" IS NOT NULL
		GROUP BY "workspace_id", "provider_thread_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: duplicate workspace/provider_thread_id values exist; reconcile them before retrying';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "setter_drafts"
		GROUP BY "conversation_message_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: multiple Setter drafts exist for a conversation message; reconcile them before retrying';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "setter_feedback"
		GROUP BY "conversation_message_id" HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0014_setter_runtime: multiple Setter feedback rows exist for a conversation message; reconcile them before retrying';
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_setter_webhook_events_provider_event" ON "setter_webhook_events" USING btree ("provider","provider_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_setter_webhook_events_provider_message" ON "setter_webhook_events" USING btree ("provider","provider_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_setter_webhook_events_status" ON "setter_webhook_events" USING btree ("status","received_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conversation_messages_provider_message" ON "conversation_messages" USING btree ("provider_message_id") WHERE "conversation_messages"."provider_message_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conversations_workspace_provider_thread" ON "conversations" USING btree ("workspace_id","provider_thread_id") WHERE "conversations"."provider_thread_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_setter_drafts_conversation_message" ON "setter_drafts" USING btree ("conversation_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_setter_feedback_conversation_message" ON "setter_feedback" USING btree ("conversation_message_id");