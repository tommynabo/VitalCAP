# PHASE 8F Apify Async Audit

## Baseline

Before edits: `npm run typecheck`, `npm run lint`, `npm test` (358 passed, 7 skipped), and `npm run build` all passed.

## Exact previous lifecycle

1. The discovery cron claimed a `discovery_job` and built a `MapsFastEngine`.
2. `MapsFastEngine.executeDiscovery()` called `MapsDiscoveryProvider.search()`.
3. `ApifyMapsDiscoveryProvider.search()` checked daily spend, built Compass input, called `ApifyClient.runAndWait()`, polled inside the same invocation, fetched one dataset page, mapped Compass items, and returned raw-ready Maps results.
4. The discovery runner immediately inserted `raw_candidates`, enqueued processing jobs, finalized `search_seed_runs`, and completed the discovery job.
5. The provider-runs cron did not poll Apify. It only recomputed spend warnings.
6. `provider_runs` represented completed/failed audit events and had no request key, actor ID, seed ID, or ingestion timestamp.

This meant normal Vercel discovery execution could remain open while an Actor ran, and a retry after an external start but before local completion could start another paid run.

## Current target lifecycle

Production `maps_fast` now calls `startActorRun()` and returns immediately with the external run ID/dataset ID. Discovery persists a `queued`/`running` `provider_run`, an open `search_seed_run`, and completes orchestration without raw candidates.

The provider-runs cron polls at most 20 runs per invocation. `READY`/`RUNNING`/transitional statuses remain running. `SUCCEEDED` records the real `usageTotalUsd`, reads the dataset with bounded pagination, maps Compass output, inserts raw candidates and processing jobs idempotently, finalizes the seed run, then changes the provider run to `ingested`. Failed, aborted, and timed-out Actor runs create no candidates.

## Apify API contract

The client uses the documented endpoints:

- `POST /v2/acts/{actorId}/runs`
- `GET /v2/actor-runs/{runId}`
- `GET /v2/datasets/{datasetId}/items` with `clean=true`, `offset`, and `limit`

The API token exists only in the client Authorization header and is never copied into provider metadata.

## Compass scope

Only `compass/crawler-google-places` is accepted by the adapter. No additional actor was enabled. The operator smoke may continue to use bounded `runAndWait()` and remains separate from production discovery.

## Idempotency and crash safety

The request key is `apify:<campaign>:<seed>:<campaign-local-day-start>`, backed by a unique database index. Existing queued/running/succeeded/ingested requests are reused rather than started again. Raw candidate uniqueness and processing-job idempotency keys make dataset replay safe if insertion succeeds before the worker crashes before marking `ingested`.

## Cost and health

Daily and per-run batch cost guards remain enforced before start. Actor completion stores the real `usageTotalUsd` when supplied. Deliberate budget refusal does not create a provider failure row. Provider health counts only actual failed terminal runs as errors; a running Actor is not a failure.

## Cron

`/api/cron/provider-runs` remains hourly (`0 * * * *`), which is compatible with the existing deployment constraint and bounds each invocation. It polls multiple runs per tick without requiring unsupported sub-minute scheduling.

## Known previous loss/risk paths verified

- Actor completion and dataset fetch previously happened inside discovery and could exceed a Vercel function lifetime.
- Provider-run audit did not distinguish Actor success from dataset ingestion.
- There was no request-level paid-run idempotency key.
- Dataset retrieval was a single page rather than a bounded pagination loop.
- Search seed runs were finalized immediately, even though async execution needs an open run until ingestion.
