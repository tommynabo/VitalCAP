-- PHASE 8G: persistent workspace-scoped Autopilot control plane.
CREATE TABLE IF NOT EXISTS autopilot_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  emergency_stopped boolean NOT NULL DEFAULT false,
  global_daily_target integer NOT NULL DEFAULT 25 CHECK (global_daily_target BETWEEN 1 AND 250),
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  operating_start_hour integer,
  operating_end_hour integer,
  max_daily_apify_spend_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_autopilot_settings_state ON autopilot_settings (enabled, emergency_stopped);
