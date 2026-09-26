# PHASE 8E Processing Audit

## Scope

This audit covers the active Neon raw-candidate to account processing path. Baseline before edits: typecheck, lint, test (353 passed, 7 skipped), and build all passed.

## Current raw_candidate flow

1. `discovery-runner.ts` claims a discovery job, executes the configured engine, persists `raw_candidates` with `ON CONFLICT DO NOTHING`, and enqueues one processing job per inserted raw candidate with idempotency key `raw_candidate:<id>`.
2. `processing-runner.ts` loads the raw candidate and campaign, derives identity signals, queries bounded account matches, and calls `processRawCandidate`.
3. `processRawCandidate` evaluates Spain, deduplicates, classifies business type, fetches or consumes crawled website pages, extracts email endpoints, and applies the verification acceptance policy.
4. The runner creates or reuses an account, writes source evidence, persists contacts, upserts campaign membership, then marks the raw candidate processed.

## Spain eligibility

`evaluateSpainEligibility` returns `verified`, `needs_review`, or `rejected`. Rejected candidates are stored with `rejected_country` and rejected campaign membership. Uncertain candidates are stored with `needs_review`; they are not ready and now use `discovered` membership rather than `qualified`.

## Business-type classification

`classifyBusinessType` runs from Maps category/name or SERP/LinkedIn title and snippet. The result is written only when a new account is created. Duplicate accounts retain their existing classification; conflicting classification remains in the incoming source snapshot.

## Website enrichment and email extraction

Maps Deep uses already-crawled pages. Other candidates perform a best-effort homepage fetch. Fetch failure does not fail processing. Extracted emails are normalized and deduplicated in memory, then persisted as `contact_points` with source URL, source type, generic/named flag, role/priority evidence, and `channelEligibility = unknown`.

## Email verification behavior

Discovery and verification are separate. With `EMAIL_VERIFICATION_PROVIDER=disabled`, the provider factory returns a truthful zero-call adapter with no outcomes. Discovered emails remain `unverified`; no verifier API is called, no provider is recorded, and the endpoint is not acceptable or ready. Provider failures use the same conservative unverified fallback. Valid/catch-all statuses are accepted only when a real verifier outcome exists.

## Account deduplication

Matching uses Google Place ID, normalized domain, normalized phone, or approved name composites. Strong and sufficiently confident fuzzy matches reuse the existing account. `account_sources` is unique for non-null source identity and insertion is now explicitly guarded for null external IDs as well.

## Account merge behavior

Before this phase, a duplicate path only attached a source. It now loads the surviving account and fills only null enrichable fields: phone, normalized phone, website/domain, Place ID, Maps URL, address, city/province/postal code, coordinates, rating/review count, and country. Existing known values are never overwritten; conflicting incoming data remains in the raw source snapshot.

## Contact-point persistence

Contact points are now persisted for both new and duplicate accounts. The database unique key `(workspace_id, type, normalized_value)` prevents case variants from becoming separate logical endpoints. Generic and named emails coexist because uniqueness is by endpoint, not label. Existing contact-point provenance is preserved; disabled verification writes a null verification provider.

## Campaign membership

Membership is upserted by `(campaign_id, account_id)`, so replay remains one row. `ready` is reserved for a genuinely acceptable verified contact. Unverified discovery is not ready. Rejected Spain is `rejected`; Spain uncertainty is `discovered`; accepted non-ready candidates are `qualified`.

## Known information-loss paths verified

- Before the fix, duplicate accounts lost newly discovered contact points because the contact loop was only in the new-account branch.
- Before the fix, disabled email verification threw in the provider factory and could dead-letter processing jobs.
- Before the fix, every persisted email claimed `email_verification` provenance even when no verification call happened.
- Before the fix, account duplicates did not fill missing fields.
- The existing database source unique index does not distinguish multiple null external IDs; the repository guard now prevents same-account replay duplicates, using source URL when available and a conservative provider/source-null identity otherwise.
- The former target calculation subtracted processing jobs even when their raw candidates were already counted, and used UTC boundaries. It now counts raw units once and uses the campaign timezone.

No destructive database operation or migration was needed.
