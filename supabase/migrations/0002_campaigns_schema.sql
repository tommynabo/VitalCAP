-- Phase 1 (Prompt 1 §1.1). Offers, campaigns, campaign memberships.
-- Not applied to any live database — see 0001_core_schema.sql header note.

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name text not null,
  company text not null,
  description text not null default '',
  primary_cta text not null,
  booking_url text not null,
  -- All commercial/product facts and claim boundaries live here as
  -- configuration, never hard-coded in application code (§1.1, Prompt 0 §0.1).
  approved_commercial_facts jsonb not null default '{}'::jsonb,
  approved_product_facts jsonb not null default '{}'::jsonb,
  approved_claims jsonb not null default '[]'::jsonb,
  forbidden_claims jsonb not null default '[]'::jsonb,
  faq jsonb not null default '[]'::jsonb,
  objection_guidance jsonb not null default '{}'::jsonb,
  tone_config jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger offers_set_updated_at
  before update on offers
  for each row execute function set_updated_at();

create index if not exists idx_offers_workspace on offers (workspace_id);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  offer_id uuid not null references offers (id) on delete restrict,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  country_code text not null default 'ES',
  engine_type text not null check (
    engine_type in ('maps_fast', 'maps_deep', 'google_serp', 'linkedin_owner', 'hybrid_fill')
  ),
  engine_config jsonb not null default '{}'::jsonb,
  daily_soft_target integer not null default 50,
  minimum_fit_score numeric,
  outreach_profile_id uuid,
  autopilot_enabled boolean not null default false,
  desired_channel_mix jsonb not null default '{"email": 50, "sms": 50}'::jsonb,
  time_zone text not null default 'Europe/Madrid',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();

create index if not exists idx_campaigns_workspace on campaigns (workspace_id);
create index if not exists idx_campaigns_status on campaigns (workspace_id, status);

create table if not exists campaign_memberships (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  selected_contact_point_id uuid references contact_points (id) on delete set null,
  stage text not null default 'discovered' check (
    stage in ('discovered', 'qualified', 'contact_selected', 'ready', 'contacted', 'rejected')
  ),
  rejection_reason text,
  ready_at timestamptz,
  contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, account_id)
);

create trigger campaign_memberships_set_updated_at
  before update on campaign_memberships
  for each row execute function set_updated_at();

create index if not exists idx_campaign_memberships_campaign on campaign_memberships (campaign_id);
create index if not exists idx_campaign_memberships_account on campaign_memberships (account_id);
create index if not exists idx_campaign_memberships_stage on campaign_memberships (campaign_id, stage);
