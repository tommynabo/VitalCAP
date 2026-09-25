-- Phase 1 (Prompt 1 §1.1). Outreach/conversation tables reserved now so
-- Phase 3 (sending) and Phase 4 (AI Setter) do not need a breaking schema
-- change later. Not applied to any live database — see 0001 header note.

create table if not exists outreach_events (
  id uuid primary key default gen_random_uuid(),
  outreach_queue_item_id uuid not null references outreach_queue (id) on delete cascade,
  state text not null check (
    state in (
      'queued', 'scheduled', 'provider_submitted', 'sent', 'delivered', 'replied',
      'failed', 'bounced', 'unsubscribed', 'canceled', 'suppressed'
    )
  ),
  provider_event_id text,
  payload_hash text,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_outreach_events_queue_item on outreach_events (outreach_queue_item_id);
create index if not exists idx_outreach_events_state on outreach_events (state);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  campaign_id uuid not null references campaigns (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  contact_point_id uuid not null references contact_points (id) on delete cascade,
  state text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger conversations_set_updated_at
  before update on conversations
  for each row execute function set_updated_at();

create index if not exists idx_conversations_workspace on conversations (workspace_id);
create index if not exists idx_conversations_account on conversations (account_id);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('email', 'phone', 'linkedin', 'other')),
  body text not null,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_messages_conversation on conversation_messages (conversation_id);

create table if not exists setter_drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  branch text,
  draft_body text not null,
  review_decision text check (review_decision in ('approved', 'rejected', 'corrected')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_setter_drafts_conversation on setter_drafts (conversation_id);

create table if not exists setter_feedback (
  id uuid primary key default gen_random_uuid(),
  setter_draft_id uuid not null references setter_drafts (id) on delete cascade,
  feedback_text text,
  corrected_body text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_setter_feedback_draft on setter_feedback (setter_draft_id);

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  account_id uuid not null references accounts (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  scheduled_for timestamptz,
  booking_url text,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'no_show', 'canceled')),
  created_at timestamptz not null default now()
);

create index if not exists idx_meetings_workspace on meetings (workspace_id);
create index if not exists idx_meetings_account on meetings (account_id);

-- ---------------------------------------------------------------------------
-- suppression_entries — universal, checked before every send (§1.2, §1.8)
-- ---------------------------------------------------------------------------

create table if not exists suppression_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  contact_point_id uuid references contact_points (id) on delete cascade,
  account_id uuid references accounts (id) on delete cascade,
  reason text not null check (
    reason in (
      'unsubscribe', 'sms_stop', 'permanent_bounce', 'manual_block',
      'compliance_block', 'account_do_not_contact', 'provider_unsubscribe'
    )
  ),
  created_at timestamptz not null default now(),
  check (contact_point_id is not null or account_id is not null)
);

create index if not exists idx_suppression_entries_workspace on suppression_entries (workspace_id);
create index if not exists idx_suppression_entries_contact_point on suppression_entries (contact_point_id);
create index if not exists idx_suppression_entries_account on suppression_entries (account_id);
