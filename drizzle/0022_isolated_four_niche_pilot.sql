CREATE TABLE pilot_control (
  id boolean PRIMARY KEY DEFAULT true NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  session_id uuid,
  workspace_id uuid REFERENCES workspaces(id),
  enabled_by text,
  enabled_at timestamptz,
  ended_by text,
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_control_singleton_id_true CHECK (id = true),
  CONSTRAINT pilot_control_status_check CHECK (status IN ('disabled', 'active', 'completed', 'aborted'))
);

INSERT INTO pilot_control (id, status) VALUES (true, 'disabled');

CREATE TABLE pilot_run_permits (
  run_key text PRIMARY KEY,
  session_id uuid NOT NULL,
  run_type text NOT NULL,
  campaign_id uuid,
  discovery_job_id uuid,
  provider_run_id uuid,
  status text NOT NULL DEFAULT 'reserved',
  charge_ceiling_usd numeric NOT NULL DEFAULT 0.50,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_run_permits_key_check CHECK (run_key IN (
    'recovery',
    '65b9f85d-4c8b-4e52-99fb-217eb3acac1c',
    '5e109452-2df2-4b1b-9afc-7baa1b67fc42',
    '47fce807-aac6-4a8a-90f9-6ad3bbbf4ca7',
    '53f56788-99d9-4d6a-8c71-ab2ffe075d85'
  )),
  CONSTRAINT pilot_run_permits_type_check CHECK (run_type IN ('recovery', 'scoped_smoke')),
  CONSTRAINT pilot_run_permits_charge_ceiling_check CHECK (charge_ceiling_usd = 0.50),
  CONSTRAINT pilot_run_permits_status_check CHECK (status IN ('reserved', 'running', 'completed', 'failed'))
);