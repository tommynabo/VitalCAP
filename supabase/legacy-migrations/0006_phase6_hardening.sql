-- Phase 6 (Prompt 6 §6.4/§6.5). DB hardening: corrects three CHECK-constraint/
-- default mismatches found by auditing 0001-0005 against the current
-- TypeScript domain types (see docs/DECISIONS.md ADR-019). Not applied to
-- any live database — see 0001_core_schema.sql header note.

-- ---------------------------------------------------------------------------
-- conversations.state: no CHECK constraint existed, and the default value
-- ('active') isn't even a member of the domain's ConversationState enum.
-- ---------------------------------------------------------------------------

alter table conversations
  alter column state set default 'reply_received';

alter table conversations
  add constraint conversations_state_check check (
    state in (
      'reply_received', 'pre_routed', 'ai_classified', 'draft_ready', 'pending_review',
      'approved', 'edited', 'rejected', 'escalated', 'sent', 'no_reply_needed',
      'suppressed', 'meeting_booked', 'human_owned'
    )
  );

-- ---------------------------------------------------------------------------
-- conversation_messages.direction: CHECK used ('inbound','outbound') but the
-- domain type is "incoming" | "outgoing" — every real insert would fail.
-- ---------------------------------------------------------------------------

alter table conversation_messages
  drop constraint if exists conversation_messages_direction_check;

alter table conversation_messages
  add constraint conversation_messages_direction_check check (direction in ('incoming', 'outgoing'));

-- ---------------------------------------------------------------------------
-- setter_drafts.review_decision: CHECK used ('approved','rejected','corrected')
-- but the domain ReviewDecision union has six different literal values.
-- ---------------------------------------------------------------------------

alter table setter_drafts
  drop constraint if exists setter_drafts_review_decision_check;

alter table setter_drafts
  add constraint setter_drafts_review_decision_check check (
    review_decision in ('approve', 'edit_and_send', 'reject', 'no_reply_needed', 'escalate', 'suppress')
  );

-- ---------------------------------------------------------------------------
-- Dashboard/time-based indexes identified as missing during the §6.5 audit.
-- ---------------------------------------------------------------------------

-- Conversations list/inbox views filter by workspace + state (e.g. "all pending_review").
create index if not exists idx_conversations_workspace_state on conversations (workspace_id, state);

-- Meetings dashboard queries by workspace + upcoming scheduled_for.
create index if not exists idx_meetings_workspace_scheduled_for on meetings (workspace_id, scheduled_for);

-- Dead-letter admin diagnostics view lists by recency.
create index if not exists idx_dead_letter_jobs_created_at on dead_letter_jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- §6.4 idempotency gap: outreach_events.provider_event_id had no uniqueness
-- constraint at the DB level. The application-level reducer
-- (ingestOutreachEvent in outreach-event-ingestion.ts) already dedupes by
-- providerEventId in memory, but a real DB-backed repository must not rely
-- on application code alone to prevent a duplicate webhook delivery (retry,
-- at-least-once delivery) from inserting a second row. Partial (not full)
-- unique index because provider_event_id is nullable for internally
-- generated events (e.g. the "scheduled" event created by the dry-run
-- orchestrator itself, which has no provider webhook to key off of).
-- ---------------------------------------------------------------------------

create unique index if not exists uq_outreach_events_provider_event_id
  on outreach_events (provider_event_id)
  where provider_event_id is not null;
