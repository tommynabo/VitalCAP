# Phase 8C - Apify Real Smoke

Status: IMPLEMENTATION COMPLETE; real smoke pending secure Neon and Apify credentials.

## Scope

- Actor: `compass/crawler-google-places`
- Query: `farmacia`
- Geography: Barcelona, Spain
- Maximum requested results: 5
- Paid contact, social, leads, reviews, images, and competitor enrichment: disabled
- Campaign: `Vitalcap - Phase 8C Maps Smoke` (draft, Autopilot disabled)

## Runtime Results

The operator-only command `npm run smoke:maps` writes the real values here after one successful run. It never writes API tokens, database URLs, authorization headers, or passwords.

- Results returned: NOT RUN
- Unique Google Place IDs: NOT RUN
- Real cost USD: NOT RUN
- Provider runs: NOT RUN
- Raw candidates inserted: NOT RUN
- Processing jobs: NOT RUN
- Accounts created: NOT RUN
- Accounts deduplicated/reused: NOT RUN
- Account sources: NOT RUN
- Spain accepted: NOT RUN
- Spain needs review: NOT RUN
- Spain rejected: NOT RUN
- Websites found: NOT RUN
- Phones found: NOT RUN
- Provider health: configured / untested

## Acceptance

- APIFY_API_TOKEN consumed server-side only: PASS
- No secret committed: PASS
- Compass current API contract verified: PASS
- Compass-specific adapter exists: PASS
- Maximum 5 result smoke enforced: PASS
- Paid enrichment disabled: PASS
- Real Apify request succeeds: NOT RUN
- Provider run persisted: NOT RUN
- Real cost recorded if available: NOT RUN
- Raw candidates persisted: NOT RUN
- Processing jobs idempotently enqueued: PASS by implementation, runtime NOT RUN
- Processing jobs complete: NOT RUN
- Spain eligibility executed: NOT RUN
- Unknown country not defaulted to ES: PASS
- Real Place ID preserved: PASS
- Accounts persisted: NOT RUN
- Account dedup works: PASS by implementation, runtime NOT RUN
- Account source provenance works: PASS by implementation, runtime NOT RUN
- Repeat processing does not duplicate accounts: PASS by implementation, runtime NOT RUN
- No email verification invoked: PASS for smoke mode
- No outreach invoked: PASS
- No Autopilot activated: PASS
- Typecheck: PASS
- Lint: PASS
- Tests: PASS (67 files, 353 passed, 7 skipped)
- Build: PASS

## Remaining Concerns

Phase 8B remains operationally blocked until a safe Neon URL is available and the Neon migration/queue integration suite runs against that database. Phase 8C must remain `FAIL / NOT READY` until the explicit smoke proves the real Apify-to-Neon path.

## Phase 8D follow-up verification

- Smoke workspace selection now requires `SMOKE_WORKSPACE_ID`; no implicit first workspace is used.
- Smoke processing claims are campaign-scoped and the smoke campaign remains `autopilotEnabled=false`.
- Deferred providers are explicitly disabled in the environment contract.
- Real Compass request remains NOT RUN because secure `APIFY_API_TOKEN` and a real Neon database were not provided.
