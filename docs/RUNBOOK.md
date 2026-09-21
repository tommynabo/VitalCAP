# Recovery Runbook (Prompt 6 §6.8)

Operational procedures for the eight required recovery scenarios. This project has no live deployment
yet (`DEV_SEED_MODE=true`, no Supabase project provisioned — see `docs/DECISIONS.md` ADR-002). Each
procedure below describes the mechanism already built to support it and the exact steps to take once a
real deployment exists. Nothing here requires code changes to execute — these are operator actions.

---

## 1. Pause outbound globally

**Mechanism:** `GlobalAutopilotState.systemHealth` plus the Autopilot page's pause control
(`src/app/(dashboard)/autopilot/page.tsx`) drive whether new discovery/verification/outreach jobs are
scheduled. The page already has a working "Pause" / "Emergency stop" control in the UI (currently local
`useState` over dev-seed data).

**Steps (once live):**
1. Go to `/autopilot` and click **Emergency stop** (or **Pause**).
2. This must persist a `campaigns.autopilot_enabled = false` (or an equivalent workspace-level flag) for
   every active campaign, and the real cron/worker entrypoint must check that flag before calling
   `claimNextJob` for any job type — no new job is claimed while paused; in-flight claimed jobs finish
   naturally (their lease still expires normally, they are not force-killed).
3. Confirm via `/admin/diagnostics` that `queueHealth.processingCount` drains to 0 and no new
   `pendingCount` growth occurs.
4. To resume: flip the flag back, click **Resume**.

**Note:** because `DEFAULT_DELIVERY_MODE=dry_run` and `AUTO_SEND_ENABLED=false` (see §6.10 below), no
real send is possible today regardless of this switch — this procedure matters once live sending is
enabled.

## 2. Pause a single campaign

**Mechanism:** `Campaign.status` (`"draft" | "active" | "paused" | "archived"`) and
`Campaign.autopilotEnabled` (`src/domain/campaigns/types.ts`).

**Steps:**
1. Set that campaign's `status` to `"paused"` (via the Campaigns page once it has a real update path, or
   directly via the repository/DB once live).
2. The real job-claim query must filter out jobs whose parent campaign is not `"active"` — every job
   table (`discovery_jobs`, `processing_jobs`, `outreach_queue`) has a `campaign_id` FK, so this is a
   join-based filter, not a per-job flag to maintain separately.
3. Existing queued/in-flight jobs for that campaign are left as-is (they will simply stop being reclaimed
   after their current attempt finishes, since the filter blocks new claims) — this does not cancel
   jobs that already completed.

## 3. Resume dead-letter jobs

**Mechanism:** `failJob` (`src/infrastructure/jobs/job-queue.ts`) moves a job to `status: "dead_letter"`
once `attemptCount >= maxAttempts` (or immediately for a permanent error per `isPermanentError`). There
is currently no automatic un-dead-letter path — by design, a dead-lettered job requires a human decision
before being retried (it already exhausted its automatic retries, or failed for a reason judged
permanent).

**Steps:**
1. Review the job via `/admin/diagnostics`' dead-letter samples panel (or `dead_letter_jobs` table
   directly once live) — read `lastError` to understand *why* it died.
2. Fix the underlying cause if any (bad payload, expired credential, provider outage now resolved).
3. Requeue by resetting that job's `status` back to `"pending"`, `attemptCount` to `0`, and
   `nextAttemptAt` to `now()` — this is the same shape `claimNextJob` already expects for a fresh
   pending job, so no new code path is needed, only a manual/admin-triggered `UPDATE`.
4. **Idempotency note:** confirm the underlying action the job represents didn't actually already
   succeed before its failure was recorded (see `docs/IDEMPOTENCY_AUDIT.md` scenario 6 — worker crash
   after provider success but before DB commit) — for an outreach-send job in particular, check
   `outreach_events` for an existing `provider_event_id` for that queue item before requeuing, to avoid
   a real duplicate send.

## 4. Rotate provider keys

**Mechanism:** every provider credential is a plain env var name in `.env.example`
(`MAPS_PROVIDER_API_KEY`, `SERP_PROVIDER_API_KEY`, `EMAIL_VERIFICATION_PROVIDER_API_KEY`,
`INSTANTLY_API_KEY`, `SMS_PROVIDER_API_KEY`, `LLM_PROVIDER_API_KEY`) — never hardcoded in source.

**Steps:**
1. Generate a new key with the provider.
2. Update the corresponding env var in Vercel's project environment variables (not in any committed
   file).
3. Redeploy (or use Vercel's "redeploy without build cache" if the runtime picks up env vars without a
   full rebuild — verify per Vercel's current env-var-refresh behavior at deploy time).
4. Revoke the old key at the provider only **after** confirming the new key works (check
   `/admin/diagnostics`'s provider health panel shows `connected`/`healthy` for that provider following
   deploy).
5. No application code needs to change — every provider adapter reads its key from `process.env` at
   call time, never at module load/build time, per the mock-adapter pattern already established.

## 5. Disable a provider

**Mechanism:** `ProviderHealthStatus` (`"healthy" | "degraded" | "paused" | "unknown"`) and
`evaluateProviderHealth` (`src/services/discovery/provider-health.ts`) already compute a `"paused"`
verdict automatically from error-rate/quota thresholds — this procedure is the **manual** equivalent
(an operator disabling a provider deliberately, e.g. ahead of planned maintenance) rather than the
automatic one.

**Steps:**
1. Manually set that engine's `EngineTargetState.providerHealth` to `"paused"` (via an admin action once
   a real settings/admin UI exists for this — today this is a dev-seed constant, see
   `seedEngineTargets` in `src/lib/seed/dev-seed.ts`).
2. `computeRebalancing`/`planHybridFillActions` (already exercised by the §6.1 Flow E test) will
   automatically redirect that engine's share of the daily target to the remaining healthy engines —
   no separate manual rebalancing action is required.
3. To re-enable: set `providerHealth` back to `"healthy"` (or let `evaluateProviderHealth` recompute it
   naturally once real usage resumes).

## 6. Recover from a bad deployment

**Steps (standard Vercel rollback — no VitalCap-specific mechanism needed):**
1. In the Vercel dashboard, go to the project's Deployments list.
2. Find the last known-good deployment and click "Promote to Production" (instant rollback, no rebuild).
3. If the bad deployment included a DB migration, **do not** blindly roll back the migration alongside
   the code — check `docs/DECISIONS.md` and `supabase/migrations/` for whether the migration is
   backward-compatible with the previous code version first (per the project's `NEVER_DESTRUCTIVE_DB`
   operational rule — never run a destructive rollback migration without a verified backup and explicit
   confirmation).
4. Confirm recovery via `/admin/diagnostics` (`dbConnectivityOk`, provider health, queue health all
   green) and the `/api/health` route.

## 7. Replay webhooks safely

**Mechanism:** `verifyWebhookSignature` + `ingestOutreachEvent`'s `providerEventId` dedup
(`src/services/outreach/outreach-event-ingestion.ts`), now backed by the DB-level partial unique index
`uq_outreach_events_provider_event_id` (`supabase/migrations/0006_phase6_hardening.sql`) — replaying an
already-processed webhook payload is safe by construction: it either signature-fails (if the payload was
altered) or dedup-skips (if it's the same `providerEventId` already ingested), never creating a
duplicate `outreach_events` row.

**Steps:**
1. Re-send the exact original captured payload (same body, same signature header) to the webhook
   endpoint.
2. Confirm the response indicates `duplicate_skipped` (or equivalent) rather than a second `sent`/
   `delivered` event being created.
3. Never hand-construct a "corrected" replay payload with a new/different `providerEventId` for an
   event that already has one — that would defeat the dedup key entirely and register as a new event.

## 8. Rerun a daily target without duplicate sends

**Mechanism:** `GlobalAutopilotState.readyToday`/`sentToday` are derived by summing current queue/account
state (see `simulate-autopilot-day.ts`), not by an incrementing counter a second run would double-apply;
`evaluateOutreachAttempt`'s cooldown (14 days default) and account-level concurrency lock
(`src/services/deduplication/outreach-dedup.ts`) additionally block a second send attempt at the same
contact-point/channel or a second endpoint on the same account while one is already in-flight; and
`idx_outreach_queue_dedup_key` backs this at the DB level.

**Steps:**
1. Simply re-run the daily target computation/dispatch for the day — it recomputes from current state,
   it does not need to be told "this already ran."
2. If specifically re-running because an earlier run appeared to hang or crash partway, first check
   `/admin/diagnostics` for any `processing`-status queue items whose lease has since expired (safe to
   reclaim automatically by the next `claimNextJob` call) versus items still within an active lease
   (leave alone — another worker/run may genuinely still be handling them).
3. No special "skip today" flag or manual duplicate-prevention step is required beyond the above —
   idempotency is structural, not operator-remembered.
