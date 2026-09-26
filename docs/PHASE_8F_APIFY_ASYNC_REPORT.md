# PHASE 8F — APIFY ASYNC

## Provider-run lifecycle

Normal Compass production discovery starts an Apify Actor and persists its external run and dataset identifiers. Polling and ingestion happen later in the provider-runs cron. `succeeded` means the Actor completed; `ingested` means bounded dataset ingestion and seed-run finalization completed.

## Request idempotency

A campaign/seed/day request key has a unique index. Discovery checks it before starting an Actor, so retries after a successful external start reuse the existing provider run.

## Dataset idempotency

Successful ingestion reads pages with `offset`/`limit`, capped at 1000 requested records per poll. Existing raw-candidate uniqueness and processing-job idempotency protect repeated polling and crash-after-insert replay.

## Cost handling

Daily and batch caps run before Actor start. Completion persists Apify's reported `usageTotalUsd` instead of estimating from elapsed time. The API token is never included in run metadata.

## Failure handling

Running and transitional Actor statuses remain active. Failed, aborted, and timed-out runs are persisted as terminal failures and do not create candidates. Budget refusal is a deliberate pause, not a provider failure. Running Actors do not affect provider health failure counts.

## Cron

`/api/cron/provider-runs` polls up to 20 Apify runs per hourly invocation and runs the existing spend/health audit alongside polling. The hourly schedule is retained for the current Vercel deployment constraints.

## Migration

`drizzle/0003_phase8f_apify_async.sql` is additive. It adds request-key, Actor, seed, ingestion, and error fields plus the unique request-key index; no destructive operation is used.

## Tests

Mocked tests cover async start without polling, explicit run-status and dataset endpoints, pagination, the 1000-item safety cap, and Compass provider behavior. No paid Apify smoke was run.

## Verification

- `Production runAndWait removed:` Yes, from the normal `maps_fast` production path; retained only for the operator smoke/synchronous compatibility path.
- `Async start:` Yes.
- `Provider run persistence:` Yes.
- `Poller:` Yes, bounded to 20 runs per tick.
- `Dataset ingest:` Yes, bounded pagination.
- `Request idempotency:` Yes, unique request key.
- `Ingest idempotency:` Yes, existing raw-candidate and processing-job uniqueness.
- `Cost tracking:` Yes, persisted from completed Apify run usage.
- `Failure handling:` Yes.
- `Tests:` PASS (362 passed, 7 skipped; 71 files passed, 1 skipped).
- `Typecheck:` PASS.
- `Lint:` PASS.
- `Build:` PASS.
- `Production deploy:` PASS (`vitalcapproject.vercel.app` aliased to the Phase 8F deployment).
- `Migration deployment:` BLOCKED: Vercel's pulled `Vitalcap_DATABASE_URL` and `Vitalcap_DATABASE_URL_UNPOOLED` variables are sealed and empty in the local CLI output, so the additive migration was not applied from this environment.
- `Production HTTP verification:` BLOCKED locally by `LibreSSL SSL_ERROR_SYSCALL` while connecting to the Vercel alias.
- `READY FOR PHASE 8G: NO` until migration deployment and HTTP verification complete.
