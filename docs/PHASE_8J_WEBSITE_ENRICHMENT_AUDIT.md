# PHASE 8J WEBSITE ENRICHMENT AUDIT

## Current State

### Pages Fetched
- Currently, `candidate-processor.ts` fetches a single page (the `websiteUrl` / homepage) during processing for most engines (`maps_fast`, `google_serp`, `linkedin_owner`).
- `maps_deep` supplies an array of `crawledPages` from the provider, but otherwise no active local crawling is performed.

### Timeout
- `safe-fetch.ts` enforces an `8000ms` (8-second) timeout.

### Redirects
- `safe-fetch.ts` handles redirects manually up to a maximum of `3` hops.

### SSRF Protections
- Actively blocks non-http(s) schemes.
- Blocks explicitly private hostnames: `localhost`, `0.0.0.0`, `metadata.google.internal`, and suffixes `.local`, `.internal`, `.localhost`.
- Blocks private, loopback, and link-local IP ranges (IPv4 and IPv6).
- Re-checks protections on every redirect hop.
- Supports pre-fetch DNS resolution validation (if `resolveHostname` is provided).

### Email Extraction
- Handled by `email-extraction.ts`.
- Uses regex to find `mailto:` links and visible `word@word.ext` patterns.
- Captures a 40-character surrounding context snippet.
- Classifies emails as generic (e.g., `info`, `contacto`, `ventas`) or non-generic based on the local part.
- Filters out false positives like image extensions or blocked domains (`example.com`).
- Deduplicates via case-normalization.

### Phone Extraction
- Currently, there is **no phone extraction** from the website HTML body. Phones are only parsed from the initial provider payload (e.g., Google Maps data).

### Evidence Retention
- No dedicated table for website evidence. The raw HTML body is used to extract emails and is immediately discarded in memory.
- Emails are mapped to `contact_points`, retaining the `sourceUrl`, but the specific HTML snippet context is not persisted to the database.

### Duplicate Behavior
- `processing-runner.ts` evaluates account deduplication (`evaluateAccountDedup`).
- If an account exists, it merges missing account fields (e.g., missing website URL or phone) and inserts a new `account_sources` row.
- It inserts any newly discovered `contact_points` into the existing account.
- It does not crawl the website again if it already has the website URL, but since there's no cache, if the candidate comes with a URL, it fetches the homepage again during processing.
