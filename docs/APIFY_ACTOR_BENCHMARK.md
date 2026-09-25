# Apify Maps Actor Benchmark

**Status: not yet run.** This file is a template. `npm run benchmark:maps`
(see `scripts/benchmark-maps.ts`) overwrites it with real, measured results
the first time it is run with a real `APIFY_API_TOKEN` — never invent
numbers here manually.

## How to run

```bash
APIFY_API_TOKEN=xxx npm run benchmark:maps
# optional flags:
APIFY_API_TOKEN=xxx npm run benchmark:maps -- --query="farmacia" --city="Madrid" --max=30
APIFY_API_TOKEN=xxx npm run benchmark:maps -- --include-deep-contact-enrichment
```

This makes real, billed Apify API calls (one real Actor run per candidate in
`src/infrastructure/providers/maps/actor-registry.ts`, excluding the
optional deep-contact-enrichment actor unless explicitly opted in). It is
**never** run automatically in CI, `npm test`, or `npm run build` (Prompt 7
§12: "Do not run paid benchmarks automatically in CI").

## What it measures (Prompt 7 §12)

For each candidate actor, using the SAME query/geography:

```text
actor
raw_places
unique_places
Spain_verified
places_with_website
places_with_phone
places_with_email
usable_accounts
runtime
errors
Apify usageTotalUsd
cost_per_raw_place
cost_per_unique_place
cost_per_usable_account
```

The actor choice for `MAPS_FAST` / `MAPS_DEEP` / `MAPS_FALLBACK` must be
based on **realized cost / usable unique account**, never headline price.
`usable_accounts` in this script is a fast heuristic (website OR phone
present) computed standalone — it is not the full
`candidate-processor.ts` eligibility/verification pipeline, so treat it as a
first-pass signal before wiring a new default actor into
`APIFY_MAPS_FAST_ACTOR`/`APIFY_MAPS_DEEP_ACTOR`/`APIFY_MAPS_FALLBACK_ACTOR`.

## Candidates benchmarked

See `src/infrastructure/providers/maps/actor-registry.ts` for the current
list and role notes (`bovi/google-maps-scraper`,
`compass/crawler-google-places`, `microworlds/crawler-google-places`, and
the optional `lukaskrivka/google-maps-with-contact-details` deep-contact
fallback).
