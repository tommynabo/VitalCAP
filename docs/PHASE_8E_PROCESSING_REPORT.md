# PHASE 8E Processing Report

## Processing pipeline:
The raw candidate path now preserves the candidate through Spain evaluation, classification, enrichment, email discovery, account merge, contact-point persistence, membership upsert, and raw processing completion. Duplicate candidates reuse one account and retain all source evidence.

## Verification-disabled behavior:
`EMAIL_VERIFICATION_PROVIDER=disabled` is a truthful zero-call adapter. Discovered emails are stored as `unverified`, with `channelEligibility = unknown` and `verificationProvider = null`. No fake valid outcome or outreach-ready promotion is possible.

## Duplicate enrichment:
Added `mergeMissingAccountFields`. Existing non-null fields are retained; incoming non-null values fill only existing nulls. Conflicts remain auditable in `account_sources` snapshots.

## Contact-point merge:
Contact persistence runs for new and duplicate accounts. Normalized endpoint uniqueness deduplicates case variants while allowing generic and named addresses to coexist.

## Status semantics:
Rejected Spain remains `rejected_country`; uncertain Spain remains `needs_review`; unverified email discovery cannot make an account `contactable` or `outreach_ready`.

## Membership semantics:
Membership remains one row per campaign/account. Unverified or uncertain candidates are never `ready`; uncertain Spain uses `discovered`, accepted non-ready candidates use `qualified`.

## Idempotency:
Raw and processing enqueue keys remain idempotent. Account source replay is guarded even for null external IDs. Contact points and campaign membership use existing database uniqueness/upsert behavior.

## Discovery target accounting:
The temporary target counts distinct persisted raw candidate rows in the campaign's local day. Processing jobs whose raw candidate already exists are not subtracted a second time; only additional in-flight work without a persisted raw candidate is counted.

## Timezone handling:
Added `getDayBounds(timeZone, now)` with DST-aware tests. Discovery passes `campaign.timeZone`, defaulting to `Europe/Madrid` at the campaign schema level.

## Migration:
None. Existing nullable verification-provider column, contact-point uniqueness, account uniqueness, source uniqueness, and membership uniqueness were sufficient.

## Tests:
Focused regression coverage added for disabled verification, unverified provenance, null-only account enrichment, conflict preservation, case-normalized endpoint handling through existing persistence contracts, and Europe/Madrid/DST day bounds. Baseline suite was green before edits: 353 passed, 7 skipped.

## Typecheck:
PASS

## Lint:
PASS (`npm run lint`).

## Build:
PASS (`npm run build`).

## Remaining processing risks:
- Account-source identity cannot perfectly distinguish two legitimate source records when both provider external ID and source URL are null; the conservative guard favors replay safety.
- The account merge policy intentionally does not overwrite dynamic rating/review counts; newer Maps evidence remains available in source snapshots for a later policy decision.
- Integration coverage for the full Neon runner remains database-dependent; the pure processing and merge regressions are covered here.

## Final status

PHASE 8E — PROCESSING PIPELINE

Verification disabled: truthful no-op, unverified
Duplicate enrichment: null-only merge implemented
Contact merge: duplicate endpoints persisted and normalized
Idempotency: source, contact, membership replay protected
Status semantics: no unverified ready promotion
Membership semantics: no unverified ready promotion
Remaining target: raw units counted once
Timezone: campaign timezone with DST-aware bounds

Tests: PASS, 358 passed, 7 skipped
Typecheck: PASS
Lint: PASS
Build: PASS

READY FOR PHASE 8F: YES
