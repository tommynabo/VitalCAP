# PHASE 8G Autopilot Control Audit

## Before changes

- The Autopilot page rendered a client-only `useState(true)` and its Pause, Resume, and Emergency Stop buttons only changed that browser-local boolean.
- No `autopilot_settings` table existed. The dashboard target was calculated by summing campaign `dailySoftTarget` values.
- The Autopilot cron loaded campaigns and computed/persisted rebalancing decisions without checking a workspace-level operating state.
- Discovery checked campaign `status` and `autopilotEnabled`, but had no workspace gate before enqueue, claim, or provider start.
- Processing claims respected campaign Autopilot enablement, but had no emergency-stop gate.
- Apify provider-run polling already ran independently of new discovery starts; this is retained so paid runs continue to be polled and ingested.
- Outreach dry-run and warm-followup runners had no emergency-stop backstop.
- Authentication resolved a current workspace from the Neon Auth user, but no reusable workspace role guard existed for mutations.
- The existing `audit_log` table could store workspace, actor, action, old/new metadata, and timestamp. It had no Autopilot control writes.
- The global target source was campaign soft-target sum, not a persisted workspace configuration.

## Authorization policy

Any workspace member can view the Autopilot page through the current workspace resolver. Admins and owners can pause, resume, change the target, emergency stop, and clear an emergency stop. Owners are exposed as a separate reusable guard for future owner-only commands. Workspace IDs are resolved server-side from the authenticated session; control requests cannot select an arbitrary workspace.

## Effective state

- `RUNNING`: `enabled=true` and `emergency_stopped=false`.
- `PAUSED`: `enabled=false` and `emergency_stopped=false`.
- `EMERGENCY_STOPPED`: `emergency_stopped=true`, regardless of `enabled`.
- Missing settings bootstrap to `PAUSED`, target 25, timezone `Europe/Madrid`.

## Worker semantics

- Planner and discovery enqueue/claim/start require RUNNING.
- PAUSED stops new discovery but allows existing processing jobs to drain.
- EMERGENCY_STOPPED blocks new processing claims and new outreach/warm-followup scheduling.
- Existing Apify runs remain visible to the provider-runs poller and continue through status polling and ingestion during pause/emergency.
- Campaign `status=active` and `autopilotEnabled=true` remain required in addition to workspace RUNNING for scheduled discovery.

## UI and metrics

The page reads settings from the server data facade. Mutations POST to an authorized server route, validate with Zod, persist, append an audit record, and reload the server-rendered state. Emergency stop requires confirmation; clearing it leaves the workspace PAUSED, so Resume cannot bypass it. Daily target is constrained to 1–250. Campaign soft targets are shown as a warning when their sum differs from the global target, without Phase 8H redistribution. Unavailable ready-buffer data is displayed as `N/A`; ready counts come from persisted campaign memberships and cron timestamps come from `cron_runs`.
