# Idempotency Audit (Prompt 6 §6.4)

Scope: verify the six required scenarios against the codebase as it stands at the end of Phase 6.
Every mechanism cited below is either (a) already covered by an existing, tested pure function, or
(b) a real gap that was fixed as part of this audit (see "Gaps fixed" below).

---

## 1. Duplicate cron run

**Scenario:** the daily-target/dispatch cron (Vercel Cron calling the discovery/processing/outreach
dispatch loop) fires twice for the same day — e.g. a retried Vercel invocation, or a manual re-trigger
while the scheduled one is still finishing.

**Protection:**
- The job queue's claim semantics (`claimNextJob` in
  [src/infrastructure/jobs/job-queue.ts](../src/infrastructure/jobs/job-queue.ts)) only ever return a
  job that is `pending`-and-due or `processing` with an **expired** lease. A second concurrent cron
  invocation calling the same claim function over the same job set can never double-claim a job another
  invocation currently holds a valid lease on — each job is processed by at most one worker at a time,
  and a duplicate cron run simply finds no claimable work if the first run already claimed everything.
- The **daily target** itself is idempotent by construction: `GlobalAutopilotState.readyToday` /
  `sentToday` (see `simulate-autopilot-day.ts`) are derived by summing already-existing queue/account
  state, not by an incrementing side effect a second cron run would double-apply. Re-running the same
  day's simulation over the same input state yields the same output state (it recomputes from the
  current snapshot rather than mutating counters).
- **Residual risk / not yet applicable:** there is no real Vercel Cron route wired up yet (no live
  deployment, no `src/app/api/cron/*` route exists in this phase) — this is a design-level guarantee
  verified via the pure functions above, not yet an end-to-end test against a real duplicate HTTP
  cron invocation. Flagged in `docs/PRODUCTION_CHECKLIST.md`.

## 2. Duplicate provider webhook

**Scenario:** a delivery/reply provider (email, SMS) retries the same webhook delivery (at-least-once
delivery is the norm for most providers), or an operator manually replays a captured webhook payload.

**Protection:**
- [src/services/outreach/outreach-event-ingestion.ts](../src/services/outreach/outreach-event-ingestion.ts):
  `verifyWebhookSignature` (HMAC-SHA256, constant-time compare via `timingSafeEqual`) rejects any
  request whose signature does not match before any state changes occur.
  `ingestOutreachEvent` dedupes on `providerEventId` — replaying the exact same event returns
  `outcome: "duplicate_skipped"` and the original event, never inserting a second row. Both are
  covered by `outreach-event-ingestion.test.ts` (idempotent-replay test asserts a second insert with
  the same `providerEventId` does not duplicate the event).
- **Gap found and fixed this audit:** the DB schema had no uniqueness constraint backing this — the
  in-memory reducer's dedup was purely an application-level guarantee. Added a partial unique index
  in `supabase/migrations/0006_phase6_hardening.sql`:
  `uq_outreach_events_provider_event_id on outreach_events (provider_event_id) where provider_event_id
  is not null`. This means even if a future repository implementation forgets to check for an existing
  `providerEventId` before inserting, the database itself rejects the duplicate row rather than
  silently creating a second `outreach_events` record for the same webhook delivery. Applied and
  syntax-validated against a throwaway local Postgres instance (all 6 migrations apply cleanly, in
  order, with `ON_ERROR_STOP=1`).

## 3. Duplicate raw candidate

**Scenario:** the same business is discovered twice — e.g. overlapping Maps Fast + Google SERP crawls,
or the same discovery job re-run after a crash re-inserts raw candidates already inserted before the
crash.

**Protection:**
- Raw candidates themselves (`raw_candidates` table) have no natural external unique key (a scraped
  payload has no stable provider ID to dedupe on), so idempotency is enforced one level up, at the
  **account** the candidate resolves to: `evaluateAccountDedup`
  ([src/services/deduplication/account-dedup.ts](../src/services/deduplication/account-dedup.ts))
  matches incoming candidates against existing accounts by strong signals (Google Place ID,
  normalized domain, normalized phone) before any new account is created, and those same three
  signals are backed by **partial unique indexes** at the DB level
  (`uq_accounts_place_id`, `uq_accounts_normalized_domain`, `uq_accounts_normalized_phone` in
  `0001_core_schema.sql`) — so even if two discovery jobs race and both attempt to create a new
  account for the same Place ID/domain/phone, the database rejects the second insert outright.
  Fuzzy/composite signals (name+postal code, name+geo-proximity) below the auto-merge confidence
  threshold are flagged for human review rather than silently merged or silently duplicated.
- Re-processing the same raw candidate twice through `processRawCandidate` is itself deterministic and
  side-effect-free (pure function over its inputs) — running it twice with the same
  `existingAccounts` snapshot produces the same `isDuplicate`/`matchedAccountKey` decision both times.

## 4. Duplicate email verification callback

**Scenario:** the email verification provider is called twice for the same address (e.g. a retried
batch request), or a cached verification result is looked up again.

**Protection:**
- [src/services/verification/email-verification-cache.ts](../src/services/verification/email-verification-cache.ts):
  `verifyEmailsWithCache` checks the injected cache store before calling the provider — an address
  already verified within the cache's TTL is never re-submitted to the provider, so a duplicate
  verification request for the same address is a cache hit, not a duplicate provider call.
  Covered by that module's existing test suite (cache-hit vs. cache-miss behavior).
- **Related hardening from this phase (§6.1 Flow F):** if the provider does throw (outage, timeout,
  etc.) mid-batch, `processRawCandidate` now catches that error (see
  [src/services/discovery/candidate-processor.ts](../src/services/discovery/candidate-processor.ts))
  and degrades to `verificationStatus: "unverified"` for all contact points on that candidate rather
  than crashing the whole pipeline — so a duplicate/retried verification callback arriving after a
  partial failure cannot leave the candidate in an inconsistent state; the candidate is simply
  re-evaluated fully on the next attempt.

## 5. Retry after timeout

**Scenario:** any job (discovery, processing, outreach dispatch) times out mid-execution — the worker
is still alive but slow, or the connection was lost after the provider call succeeded but before the
worker could report completion.

**Protection:**
- `claimNextJob`'s lease semantics: a claimed job is only reclaimable by another worker once
  `lockedAt + leaseMs <= now` — i.e. after the lease genuinely expires, not immediately. This bounds
  how long a slow-but-alive worker is safe from a concurrent re-claim, and guarantees a truly stuck
  worker's job does eventually become claimable again (crash recovery), rather than staying locked
  forever.
- `failJob` classifies errors as permanent (dead-letter immediately — bad input, 4xx-shaped) or
  transient (retry with exponential backoff via `computeBackoffMs`, capped, until `maxAttempts` is
  reached, then dead-letter). A timeout is treated as transient by `isPermanentError`'s default regex
  (it does not match `invalid|not_found|unauthorized|forbidden|bad_request`), so a retried job after a
  timeout backs off exponentially rather than hot-looping.
- All of the above is covered by `job-queue.test.ts` (reclaim-after-expired-lease,
  backoff-doubles-and-caps, transient-vs-permanent classification, dead-letter-at-maxAttempts).

## 6. Worker crash after provider success but before DB commit

**Scenario:** the worst case — an outbound send (or any provider call with an external side effect)
succeeds against the provider, but the worker crashes before it can record that success in the DB, so
on restart the job still looks `pending`/`processing` and could be re-attempted, risking a **second**
real send for the same intended action.

**Protection / current state:**
- The **queue-level idempotency key** (`idx_outreach_queue_dedup_key on outreach_queue (contact_point_id,
  campaign_id, channel)` in `0003_jobs_schema.sql`) plus `evaluateOutreachAttempt`'s cooldown +
  account-concurrency-lock logic
  ([src/services/deduplication/outreach-dedup.ts](../src/services/deduplication/outreach-dedup.ts))
  means a second attempt at the same contact-point/campaign/channel within the cooldown window (14
  days by default) or while another endpoint on the same account is still in-flight is refused before
  a second send is ever attempted — this significantly narrows the crash window's blast radius even
  without a full two-phase commit.
- `outreach_events.provider_event_id` (now uniquely indexed, see scenario 2) means that **if** the
  provider's own webhook confirms the send after the fact, replaying/duplicating that confirmation
  cannot create two "sent" event rows even if the worker's own commit was lost.
- **Explicitly NOT fully solved:** this project runs exclusively in `dry_run` mode
  (`DEFAULT_DELIVERY_MODE=dry_run`, `AUTO_SEND_ENABLED=false` — see §6.10 verification below) and no
  provider has ever been called for a real send. True "provider success, DB commit lost" is a risk
  that only exists once live sending is enabled. Before that flag is ever flipped, the real repository
  layer must implement the outbound send as: (1) claim the queue item (existing job-queue semantics),
  (2) call the provider, (3) **immediately and synchronously** persist the provider's returned
  message/event ID in the same transaction/request as marking the queue item `sent` — a queue item
  left `processing` past its lease is safe to reclaim under the current pending job-queue design.

  **Recommendation for whoever wires up the real Supabase-backed repository:** the reclaim path itself
  is what turns a crash-after-provider-success situation into a duplicate-send unless the FIRST action
  on reclaim is to check the provider for an existing message with that job's idempotency key before
  ever attempting to send again. That check is provider-specific plumbing that does not exist yet
  (every provider is a mock — see the Provider Matrix in `docs/PHASE_6_REPORT.md`) — documented here as
  a known limitation, not fixed speculatively without a real provider to validate against.

---

## Summary

| # | Scenario | Status |
|---|----------|--------|
| 1 | Duplicate cron run | Covered by job-queue claim/lease semantics + stateless recompute; no live cron route yet to end-to-end test |
| 2 | Duplicate provider webhook | Covered (HMAC + app-level dedup); **DB unique index gap found and fixed this audit** |
| 3 | Duplicate raw candidate | Covered by account-level strong-signal DB unique indexes + fuzzy-match human review |
| 4 | Duplicate verification callback | Covered by verification cache; degrades gracefully on provider outage (§6.1 Flow F fix) |
| 5 | Retry after timeout | Covered by lease expiry + exponential backoff + permanent/transient classification |
| 6 | Worker crash after provider success, before DB commit | Partially mitigated (dedup key + cooldown + concurrency lock); full protection requires provider-specific "check before re-send" logic not implementable against mock providers — documented as a pre-go-live blocker |
