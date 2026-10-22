CREATE TABLE "instantly_inbox_reconcile_state" (
  "provider_campaign_id" text PRIMARY KEY,
  "checkpoint_at" timestamptz,
  "window_started_at" timestamptz,
  "next_starting_after" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
