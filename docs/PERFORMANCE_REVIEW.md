# Performance Review (Prompt 6 §6.7)

Scope: review the codebase as it stands at the end of Phase 6 against the six specific anti-patterns
called out in the master prompt. Most of this phase's app runs against `DEV_SEED_MODE=true` in-memory
fixtures (no live database yet), so several items are "not yet applicable" rather than "fixed" — noted
explicitly below, with what will matter once real persistence is wired up.

---

## N+1 account/contact queries

Not applicable yet — there is no live database, so there are no per-row queries to count. The service
functions that will eventually back real repository calls are already written to operate over whole
collections passed in as arguments (e.g. `evaluateAccountDedup(incoming, existing: readonly
AccountIdentitySignals[])`, `claimNextJob(jobs: readonly JobRecord[], ...)`) rather than looping and
issuing one lookup per item — this shape naturally maps to a single batched Supabase query (`select *
from accounts where workspace_id = $1`) rather than a query-per-account when the real repository layer
is built. Flagged in `docs/PRODUCTION_CHECKLIST.md`: whoever implements the Supabase-backed repository
must preserve this "fetch the working set once, operate over it in memory" shape rather than
introducing per-item queries inside a loop.

## Re-crawling the same domain repeatedly

Covered: [src/services/enrichment/website-crawler.ts](../src/services/enrichment/website-crawler.ts)'s
`crawlWebsite` maintains a `visited` `Set<string>` of URLs already fetched within a single crawl and
never re-fetches one (`if (visited.has(link)) continue`), is bounded by `maxPages` (default 6), and only
follows same-origin links matching a small high-value keyword list (contact/about/team/legal pages) —
never a full-site crawl. Across separate discovery runs (Maps Fast vs. Maps Deep vs. re-processing),
each engine call is independent; there is no cross-run crawl cache yet, but repeated engine runs are
themselves rate-limited by the campaign's daily target and job-queue dispatch cadence, not by an
unbounded loop.

## Repeated verification

Covered: [src/services/verification/email-verification-cache.ts](../src/services/verification/email-verification-cache.ts)
(`verifyEmailsWithCache`) checks an injected cache store before ever calling the verification provider —
an address already verified within the cache's TTL returns the cached result instead of a duplicate
provider call. Tested (cache-hit vs. cache-miss).

## Unbounded cron processing

Covered by the job-queue design: `claimNextJob` claims **exactly one** job per call — the calling loop
(worker/cron handler) controls how many jobs are processed per invocation, so nothing about the queue
primitives themselves permits an unbounded single-pass batch. `discovery_jobs`/`processing_jobs`/
`outreach_queue` all have a `(status, next_attempt_at)` index (`idx_*_dispatch` in
`0003_jobs_schema.sql`) so that lookup itself is indexed rather than a full table scan even once real
data volume grows. **Not yet applicable end-to-end:** there is no real cron route yet
(`src/app/api/cron/*` doesn't exist) to set an explicit per-invocation batch-size cap on — flagged in
`docs/PRODUCTION_CHECKLIST.md` that the real cron handler must loop `claimNextJob` up to a fixed N per
invocation (not "until empty"), so a large backlog is drained over several cron ticks rather than one
long-running request risking a serverless function timeout.

## Giant JSON payloads in UI

Dashboard pages (e.g. `src/app/(dashboard)/accounts/page.tsx`, `outreach/page.tsx`) currently render
directly from small, fixed dev-seed arrays (`seedAccountBundles`, etc.) with no pagination — acceptable
today because the seed data is intentionally small and illustrative, not representative of real volume.
**Not yet applicable / flagged:** once real data is wired up, these list views must paginate (the
master prompt explicitly says "use pagination") rather than fetching and rendering an entire table's
rows client-side. Recorded as a required follow-up before go-live in `docs/PRODUCTION_CHECKLIST.md`.

## Synchronous provider chains in request/response paths

The one real API route (`src/app/api/health/route.ts`) makes no provider calls at all — it only reads
`getServerEnv()` and returns a JSON status object, so there is no synchronous provider chain in any
request/response path today. The dry-run outreach orchestrator
(`runOutreachDryRunCycle` in `src/services/outreach/outreach-orchestrator.ts`) and the discovery
pipeline (`processRawCandidate`) are both `async` functions designed to be invoked from a background
job/worker context (per the job-queue design), not from an HTTP request handler awaiting a user's
button click — this separation is intentional and already in place, not something introduced this
phase. No violation found.

## Pagination

Explicitly noted above (giant JSON payloads section) as a required follow-up once real, larger-than-seed
data volume exists — not a defect in the current phase given the deliberately small seed dataset, but a
concrete item in `docs/PRODUCTION_CHECKLIST.md`.

## EXPLAIN on critical queries

Not run — there is no live database this phase to run `EXPLAIN` against (per ADR-002/every migration
file's header: none of `0001`-`0006` have ever been applied to a live/production Supabase project). The
indexes that would matter for the critical dashboard/queue queries are already in place from Phase 1 and
this phase's `0006_phase6_hardening.sql` addition (`idx_*_dispatch` for queue claim ordering,
`idx_conversations_workspace_state` for the inbox view, `idx_meetings_workspace_scheduled_for` for the
meetings dashboard, `idx_dead_letter_jobs_created_at` for the new admin diagnostics view) — recommend
running `EXPLAIN ANALYZE` on the actual dashboard queries once a real Supabase project exists and has a
realistic amount of seeded data, to confirm these indexes are actually used by the planner rather than
just present.

## Summary

| Concern | Status |
|---|---|
| N+1 queries | N/A yet (no live DB); service functions already shaped to avoid it |
| Re-crawling same domain | Covered — bounded, deduped, keyword-targeted crawl |
| Repeated verification | Covered — cache-backed, tested |
| Unbounded cron processing | Design supports bounded batches; no live cron route yet to cap |
| Giant JSON in UI / pagination | N/A yet (small seed data); flagged for go-live |
| Synchronous provider chains in request path | Not found; orchestrator functions are job-context only |
| EXPLAIN on critical queries | Not run (no live DB); indexes already in place for future verification |
