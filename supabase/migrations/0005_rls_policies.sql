-- Phase 1 (Prompt 1 §1.7). Workspace-scoped Row Level Security for every
-- table introduced in 0001-0004, plus an audit_log for privileged mutations
-- (account merges, suppression entries). Not applied to any live database —
-- see 0001_core_schema.sql header note.
--
-- Design note: tables that don't carry `workspace_id` directly (e.g.
-- `account_sources`, `conversation_messages`) are scoped via a join back to
-- their parent's `workspace_id` through a small `security definer` helper
-- rather than a single generic "assume every table has workspace_id" loop —
-- the FK path to workspace_id differs per table, so a fully dynamic loop
-- would either be wrong for several tables or need per-table exceptions
-- anyway. Explicit, readable policies were chosen over cleverness.

create or replace function is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- workspaces / workspace_members
-- ---------------------------------------------------------------------------

alter table workspaces enable row level security;
alter table workspace_members enable row level security;

create policy workspaces_select on workspaces
  for select using (is_workspace_member(id));

create policy workspace_members_select on workspace_members
  for select using (is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Directly workspace-scoped tables
-- ---------------------------------------------------------------------------

alter table accounts enable row level security;
alter table contacts enable row level security;
alter table contact_points enable row level security;
alter table offers enable row level security;
alter table campaigns enable row level security;
alter table conversations enable row level security;
alter table meetings enable row level security;
alter table suppression_entries enable row level security;

create policy accounts_all on accounts
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy contacts_all on contacts
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy contact_points_all on contact_points
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy offers_all on offers
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy campaigns_all on campaigns
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy conversations_all on conversations
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy meetings_all on meetings
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

create policy suppression_entries_all on suppression_entries
  for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Scoped via a join to accounts.workspace_id
-- ---------------------------------------------------------------------------

alter table account_sources enable row level security;
alter table account_merge_records enable row level security;

create policy account_sources_all on account_sources
  for all using (
    exists (select 1 from accounts a where a.id = account_sources.account_id and is_workspace_member(a.workspace_id))
  )
  with check (
    exists (select 1 from accounts a where a.id = account_sources.account_id and is_workspace_member(a.workspace_id))
  );

create policy account_merge_records_all on account_merge_records
  for all using (
    exists (select 1 from accounts a where a.id = account_merge_records.surviving_account_id and is_workspace_member(a.workspace_id))
  )
  with check (
    exists (select 1 from accounts a where a.id = account_merge_records.surviving_account_id and is_workspace_member(a.workspace_id))
  );

-- ---------------------------------------------------------------------------
-- Scoped via a join to campaigns.workspace_id
-- ---------------------------------------------------------------------------

alter table campaign_memberships enable row level security;
alter table discovery_jobs enable row level security;
alter table raw_candidates enable row level security;
alter table processing_jobs enable row level security;
alter table outreach_queue enable row level security;

create policy campaign_memberships_all on campaign_memberships
  for all using (
    exists (select 1 from campaigns c where c.id = campaign_memberships.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    exists (select 1 from campaigns c where c.id = campaign_memberships.campaign_id and is_workspace_member(c.workspace_id))
  );

create policy discovery_jobs_all on discovery_jobs
  for all using (
    exists (select 1 from campaigns c where c.id = discovery_jobs.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    exists (select 1 from campaigns c where c.id = discovery_jobs.campaign_id and is_workspace_member(c.workspace_id))
  );

create policy raw_candidates_all on raw_candidates
  for all using (
    exists (select 1 from campaigns c where c.id = raw_candidates.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    exists (select 1 from campaigns c where c.id = raw_candidates.campaign_id and is_workspace_member(c.workspace_id))
  );

create policy processing_jobs_all on processing_jobs
  for all using (
    exists (select 1 from campaigns c where c.id = processing_jobs.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    exists (select 1 from campaigns c where c.id = processing_jobs.campaign_id and is_workspace_member(c.workspace_id))
  );

create policy outreach_queue_all on outreach_queue
  for all using (
    exists (select 1 from campaigns c where c.id = outreach_queue.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    exists (select 1 from campaigns c where c.id = outreach_queue.campaign_id and is_workspace_member(c.workspace_id))
  );

-- dead_letter_jobs.campaign_id is nullable (a job can outlive its campaign);
-- fall back to deny-by-default (no policy = no access) when it's null, since
-- there's no other workspace anchor to check.
alter table dead_letter_jobs enable row level security;

create policy dead_letter_jobs_all on dead_letter_jobs
  for all using (
    campaign_id is not null
    and exists (select 1 from campaigns c where c.id = dead_letter_jobs.campaign_id and is_workspace_member(c.workspace_id))
  )
  with check (
    campaign_id is not null
    and exists (select 1 from campaigns c where c.id = dead_letter_jobs.campaign_id and is_workspace_member(c.workspace_id))
  );

-- ---------------------------------------------------------------------------
-- Scoped via a join through outreach_queue / conversations
-- ---------------------------------------------------------------------------

alter table outreach_events enable row level security;
alter table conversation_messages enable row level security;
alter table setter_drafts enable row level security;
alter table setter_feedback enable row level security;

create policy outreach_events_all on outreach_events
  for all using (
    exists (
      select 1 from outreach_queue oq
      join campaigns c on c.id = oq.campaign_id
      where oq.id = outreach_events.outreach_queue_item_id and is_workspace_member(c.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from outreach_queue oq
      join campaigns c on c.id = oq.campaign_id
      where oq.id = outreach_events.outreach_queue_item_id and is_workspace_member(c.workspace_id)
    )
  );

create policy conversation_messages_all on conversation_messages
  for all using (
    exists (select 1 from conversations co where co.id = conversation_messages.conversation_id and is_workspace_member(co.workspace_id))
  )
  with check (
    exists (select 1 from conversations co where co.id = conversation_messages.conversation_id and is_workspace_member(co.workspace_id))
  );

create policy setter_drafts_all on setter_drafts
  for all using (
    exists (select 1 from conversations co where co.id = setter_drafts.conversation_id and is_workspace_member(co.workspace_id))
  )
  with check (
    exists (select 1 from conversations co where co.id = setter_drafts.conversation_id and is_workspace_member(co.workspace_id))
  );

create policy setter_feedback_all on setter_feedback
  for all using (
    exists (
      select 1 from setter_drafts sd
      join conversations co on co.id = sd.conversation_id
      where sd.id = setter_feedback.setter_draft_id and is_workspace_member(co.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from setter_drafts sd
      join conversations co on co.id = sd.conversation_id
      where sd.id = setter_feedback.setter_draft_id and is_workspace_member(co.workspace_id)
    )
  );

-- ---------------------------------------------------------------------------
-- audit_log — privileged mutations (account merges, suppressions) (§1.7)
-- ---------------------------------------------------------------------------

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  actor uuid,
  changed_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- No RLS select policy is granted on audit_log to regular workspace
-- members — it is service-role/read-only-for-admins by design, so simply
-- enabling RLS with zero policies denies all access except service role.
alter table audit_log enable row level security;

create or replace function log_privileged_mutation()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into audit_log (table_name, row_id, operation, actor, changed_data)
  values (
    tg_table_name,
    coalesce(new.id, old.id),
    lower(tg_op),
    auth.uid(),
    to_jsonb(coalesce(new, old))
  );
  return coalesce(new, old);
end;
$$;

create trigger account_merge_records_audit
  after insert or update or delete on account_merge_records
  for each row execute function log_privileged_mutation();

create trigger suppression_entries_audit
  after insert or update or delete on suppression_entries
  for each row execute function log_privileged_mutation();
