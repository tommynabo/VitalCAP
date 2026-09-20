-- Phase 1 (Prompt 1 §1.1). Durable job/queue tables — no reliance on
-- ephemeral in-process promises for discovery/processing/outreach dispatch.
-- Not applied to any live database — see 0001_core_schema.sql header note.

create table if not exists discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger discovery_jobs_set_updated_at
  before update on discovery_jobs
  for each row execute function set_updated_at();

create index if not exists idx_discovery_jobs_campaign on discovery_jobs (campaign_id);
create index if not exists idx_discovery_jobs_dispatch on discovery_jobs (status, next_attempt_at);

create table if not exists raw_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_job_id uuid not null references discovery_jobs (id) on delete cascade,
  campaign_id uuid not null references campaigns (id) on delete cascade,
  source_type text not null,
  source_provider text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_raw_candidates_job on raw_candidates (discovery_job_id);
create index if not exists idx_raw_candidates_unprocessed on raw_candidates (campaign_id) where processed = false;

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger processing_jobs_set_updated_at
  before update on processing_jobs
  for each row execute function set_updated_at();

create index if not exists idx_processing_jobs_campaign on processing_jobs (campaign_id);
create index if not exists idx_processing_jobs_dispatch on processing_jobs (status, next_attempt_at);

create table if not exists outreach_queue (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns (id) on delete cascade,
  type text not null default 'send_outreach',
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  account_id uuid not null references accounts (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  contact_point_id uuid not null references contact_points (id) on delete cascade,
  channel text not null check (channel in ('email', 'phone', 'linkedin', 'other')),
  priority numeric not null default 0,
  scheduled_for timestamptz,
  delivery_mode text not null default 'dry_run' check (delivery_mode in ('dry_run', 'live')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger outreach_queue_set_updated_at
  before update on outreach_queue
  for each row execute function set_updated_at();

create index if not exists idx_outreach_queue_campaign on outreach_queue (campaign_id);
create index if not exists idx_outreach_queue_dispatch on outreach_queue (status, next_attempt_at);
create index if not exists idx_outreach_queue_account on outreach_queue (account_id);
-- Outreach dedup: contact_point + campaign + channel (§1.2).
create index if not exists idx_outreach_queue_dedup_key on outreach_queue (contact_point_id, campaign_id, channel);

create table if not exists dead_letter_jobs (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (source_table in ('discovery_jobs', 'processing_jobs', 'outreach_queue')),
  source_job_id uuid not null,
  campaign_id uuid references campaigns (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null,
  last_error text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_dead_letter_jobs_source on dead_letter_jobs (source_table, source_job_id);
