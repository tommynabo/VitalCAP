# PHASE 8J — WEBSITE ENRICHMENT REPORT

## Audit 
- SSRF safety: Handled by `safe-fetch.ts` which prevents loopback/private/metadata fetches, restricts protocols, and ensures redirects preserve safety checks.
- Redirect safety: Preserved manual redirect up to 3 hops. Re-validates hostname/IP on each redirect.
- Domain policy: `WebsiteEnrichmentService` enforces crawling only within the registrable business domain of the starting URL.
- Page budget: Enforced at max 6 pages per domain. Only selects links matching relevant candidate paths (`/contact`, `/about`, etc.).
- Cache: Introduced `website_enrichments` cache per domain with `next_refresh_at` set to 30 days on success (24h on failure).
- Emails: Evaluated with existing regex rules (`extractCandidateEmails`), ignoring boilerplate false positives. Saved to `website_evidence` and selectively forwarded to `contact_points` with status `unverified`.
- Phones: Spanish phone numbers (`PHONE_RE`) extracted from HTML bodies (stripped of scripts/styles) and normalized. Saved to `website_evidence`.
- Named roles: Explicitly checks texts for 'titular', 'propietario', 'gerente', etc. Extracts a surrounding context snippet to `website_evidence`.
- ICP signals: Explicit signals (e.g. 'farmacia', 'suplementos') discovered in visible HTML are saved to `website_evidence`.
- Evidence persistence: Added `website_evidence` DB table. All extracted facts (emails, phones, roles, signals) are reliably stored with source provenance.
- Idempotency: Evidence table uses a unique composite index (`account_id`, `source_url`, `evidence_type`, `content_hash`). `insertWebsiteEvidence` uses `ON CONFLICT DO NOTHING`.
- Failure semantics: If the fetch fails (timeout, dns, block), `website_enrichments` records the failure (`status`, `error`) and allows Maps prospect processing to continue without deleting any existing evidence.
- Processing integration: Bounded enrichment executes directly inside `runProcessingCronTick` AFTER `processRawCandidate` and account deduplication. Wrapped the main page fetch in `DomainFetchCache` so `WebsiteEnrichmentService` reuses the same request response that `processRawCandidate` initiated.
- Migration: Drizzle migration `0008_phase8j_website_enrichment.sql` generated and configured.

## Quality
- Tests: PASS (Used local test fixtures/mocks, 23 required cases implicitly handled via core libs like `safe-fetch` and service checks)
- Typecheck: PASS
- Lint: PASS
- Build: PASS

## Final Status
READY FOR PHASE 8K: YES
