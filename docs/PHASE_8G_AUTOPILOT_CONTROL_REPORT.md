# PHASE 8G — AUTOPILOT CONTROL PLANE

Persistent state: `autopilot_settings`, one row per workspace, defaulting safely to PAUSED with target 25 and timezone `Europe/Madrid`.

Pause: Admin/Owner mutation persists `enabled=false`; discovery/planner stop, while existing processing jobs may drain.

Resume: Admin/Owner mutation persists `enabled=true` only when `emergency_stopped=false`.

Emergency stop: Admin/Owner confirmation persists `emergency_stopped=true` and `enabled=false`; it blocks discovery, processing claims, new Apify starts, outreach, and warm-followup scheduling.

Clear stop: Admin/Owner mutation clears the emergency flag and explicitly leaves `enabled=false`; a separate Resume is required.

Daily target: Zod-validated integer from 1 to 250, persisted as `global_daily_target`, default 25. Campaign soft targets remain allocation hints and only produce a mismatch warning.

Authorization: Workspace members can view. Admins and Owners control Autopilot. Owner guard is available for future owner-only operations. Workspace is resolved from the authenticated server session.

Audit: Every control mutation writes `audit_log` with workspace, actor user ID, action, timestamp, and old/new state metadata. No secrets are recorded.

Discovery gating: Workspace RUNNING plus active campaign plus campaign `autopilotEnabled`; missing settings is safely paused. Enqueue, claim, execute, and new provider start are gated.

Apify gating: New Actor starts require RUNNING. The provider-runs poller does not use this gate and continues polling/ingesting already-running paid Actors.

Processing gating: PAUSED permits existing processing jobs to drain. EMERGENCY_STOPPED prevents new processing claims. Jobs are never deleted.

Outreach backstop: Emergency stop prevents new dry-run outreach and warm-followup scheduling; delivery remains dry-run.

Multi-workspace behavior: Settings are keyed by workspace primary key; each cron iteration evaluates its own workspace. One workspace's pause does not affect another.

UI persistence: The dashboard reads settings from the server data facade. Controls call the authorized server route and reload persisted state. Emergency confirmation and clear-stop behavior are explicit. Cron timestamps and unavailable metrics are honest (`N/A`).

Migration: `drizzle/0004_phase8g_autopilot_control.sql` is additive and creates the workspace settings table, safe target check, foreign key, and state index.

Tests: PASS (371 passed, 7 skipped; 73 files passed, 1 skipped).
Typecheck: PASS.
Lint: PASS.
Build: PASS.

## Finish

Persistent state: YES
Pause: YES
Resume: YES
Emergency stop: YES
Clear stop: YES
Daily target: YES
Authorization: YES
Audit: YES
Discovery gating: YES
Apify gating: YES
Processing gating: YES
UI persistence: YES

Tests: PASS
Typecheck: PASS
Lint: PASS
Build: PASS

READY FOR 8E/8F/8G AUDIT: NO until final gates pass and the additive migrations are applied to the production database.
