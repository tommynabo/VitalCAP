-- Phase 1 (Prompt 1 §1.1, §1.2). Workspaces + core account/contact graph.
--
-- NOTE: This migration is version-controlled infrastructure-as-code. It has
-- NOT been applied to any live database in this session — no Supabase
-- project is provisioned yet (see docs/DECISIONS.md ADR-007). Review before
-- ever running `supabase db push` / `migration up` against a real project.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_workspace_members_user on workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger helper (reused by every table below and later migrations)
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  canonical_name text not null,
  normalized_name text not null,
  business_type text not null check (
    business_type in ('pharmacy', 'parapharmacy', 'herbal_shop', 'sports_nutrition_store', 'supplement_store', 'other_retail')
  ),
  -- Not constrained to 'ES' only: a rejected non-Spain candidate must remain
  -- storable (status = 'rejected_country') as audit evidence. See §1.4.
  country_code text not null,
  region text,
  province text,
  city text,
  postal_code text,
  address_line text,
  normalized_address text,
  latitude double precision,
  longitude double precision,
  phone text,
  normalized_phone text,
  website_url text,
  normalized_domain text,
  google_place_id text,
  maps_url text,
  rating numeric,
  review_count integer,
  fit_score numeric,
  fit_tier text not null default 'unscored' check (fit_tier in ('high', 'medium', 'low', 'unscored')),
  status text not null default 'discovered' check (
    status in (
      'discovered', 'normalized', 'deduped', 'country_verified', 'enriched', 'qualified',
      'contactable', 'outreach_ready', 'rejected_country', 'rejected_icp', 'duplicate_merged',
      'needs_review', 'no_contact_found', 'archived'
    )
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

create index if not exists idx_accounts_workspace on accounts (workspace_id);
create index if not exists idx_accounts_status on accounts (workspace_id, status);

-- Strong dedup signals: unique per workspace, but only enforced when the
-- value is present (partial index) — most rows won't have every identity.
create unique index if not exists uq_accounts_place_id
  on accounts (workspace_id, google_place_id) where google_place_id is not null;
create unique index if not exists uq_accounts_normalized_domain
  on accounts (workspace_id, normalized_domain) where normalized_domain is not null;
create unique index if not exists uq_accounts_normalized_phone
  on accounts (workspace_id, normalized_phone) where normalized_phone is not null;

-- Fuzzy/composite dedup lookups (name+postal code, name+address).
create index if not exists idx_accounts_name_postal
  on accounts (workspace_id, normalized_name, postal_code);
create index if not exists idx_accounts_name_address
  on accounts (workspace_id, normalized_name, normalized_address);

-- ---------------------------------------------------------------------------
-- account_sources
-- ---------------------------------------------------------------------------

create table if not exists account_sources (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  source_type text not null check (
    source_type in ('maps_fast', 'maps_deep', 'google_serp', 'linkedin_owner', 'hybrid_fill', 'manual')
  ),
  source_provider text not null,
  source_external_id text,
  source_url text,
  raw_snapshot jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now()
);

create index if not exists idx_account_sources_account on account_sources (account_id);

-- ---------------------------------------------------------------------------
-- account_merge_records — audit trail for DeduplicationService (§1.2)
-- ---------------------------------------------------------------------------

create table if not exists account_merge_records (
  id uuid primary key default gen_random_uuid(),
  surviving_account_id uuid not null references accounts (id) on delete cascade,
  merged_account_id uuid not null references accounts (id) on delete cascade,
  matched_signal text not null check (
    matched_signal in (
      'google_place_id', 'normalized_domain', 'normalized_phone',
      'name_postal_code', 'name_address', 'name_geo_proximity'
    )
  ),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  decided_by text not null check (decided_by in ('auto', 'human_review')),
  created_at timestamptz not null default now()
);

create index if not exists idx_account_merge_records_surviving on account_merge_records (surviving_account_id);
create index if not exists idx_account_merge_records_merged on account_merge_records (merged_account_id);

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  first_name text,
  last_name text,
  full_name text,
  job_title text,
  role_type text not null default 'unknown' check (
    role_type in ('owner', 'titular_pharmacist', 'manager', 'purchasing_manager', 'buyer', 'employee', 'generic_role', 'unknown')
  ),
  is_decision_maker boolean not null default false,
  seniority text not null default 'unknown' check (seniority in ('owner', 'senior', 'mid', 'junior', 'unknown')),
  linkedin_url text,
  source_confidence numeric not null default 0 check (source_confidence >= 0 and source_confidence <= 1),
  status text not null default 'active' check (status in ('active', 'needs_review', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger contacts_set_updated_at
  before update on contacts
  for each row execute function set_updated_at();

create index if not exists idx_contacts_workspace on contacts (workspace_id);
create index if not exists idx_contacts_account on contacts (account_id);
-- Composite contact dedup signal: normalized full name + account.
create index if not exists idx_contacts_account_fullname on contacts (account_id, full_name);

-- ---------------------------------------------------------------------------
-- contact_points
-- ---------------------------------------------------------------------------

create table if not exists contact_points (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  type text not null check (type in ('email', 'phone', 'linkedin', 'other')),
  value text not null,
  normalized_value text not null,
  label text,
  is_generic boolean not null default false,
  is_personal_or_named boolean not null default false,
  priority_score numeric not null default 0,
  verification_status text not null default 'unverified' check (
    verification_status in ('unverified', 'valid', 'catch_all', 'risky', 'invalid', 'unknown', 'disposable', 'bounced')
  ),
  verification_provider text,
  verification_checked_at timestamptz,
  channel_eligibility text not null default 'unknown' check (
    channel_eligibility in (
      'unknown', 'professional_contact', 'eligible_email', 'eligible_sms', 'eligible_call',
      'consented_email', 'consented_sms', 'prior_relationship', 'opted_out', 'blocked'
    )
  ),
  source_url text,
  source_type text,
  last_contacted_at timestamptz,
  status text not null default 'discovered' check (
    status in (
      'discovered', 'normalized', 'unverified', 'valid', 'catch_all', 'risky', 'invalid',
      'eligible', 'ineligible', 'selected', 'queued', 'contacted'
    )
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger contact_points_set_updated_at
  before update on contact_points
  for each row execute function set_updated_at();

create index if not exists idx_contact_points_workspace on contact_points (workspace_id);
create index if not exists idx_contact_points_account on contact_points (account_id);
create index if not exists idx_contact_points_contact on contact_points (contact_id);

-- Strong contact dedup signals: normalized email/phone/LinkedIn URL, unique
-- per workspace + type when present. A pharmacy can have owner + purchasing
-- + manager + info@ + phone simultaneously — those are different `value`s,
-- so this does not block legitimate multi-contact-point accounts (§1.1).
create unique index if not exists uq_contact_points_normalized_value
  on contact_points (workspace_id, type, normalized_value);
