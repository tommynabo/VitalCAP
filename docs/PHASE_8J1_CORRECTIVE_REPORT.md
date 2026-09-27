# PHASE 8J.1 — CORRECTIVE REPORT

## SECURITY
- `.env.production` removed: YES
- `gitignore`: YES (Hardened to ignore `.env*` and only allow `.env.example`)
- credentials rotated/revoked: OPERATOR REQUIRED
- history purge: OPERATOR REQUIRED

## MIGRATION
- `0008` state: Was NEVER successfully applied to any DB in its buggy state (only generated locally).
- corrective migration: Overwrote `0008_phase8j_website_enrichment.sql` with a CLEAN, purely additive schema containing ONLY `website_enrichments`, `website_evidence`, and their respective constraints/indexes.
- fresh-db migration chain: PASS
- production migration: PASS
- `smoke:db`: PASS

## WEBSITE CACHE
- account scope: YES. Implemented using unique index on `(account_id, normalized_domain)`.
- TTL: 30 days for successes (`completed`), 24h for transient errors, and 1 year for `blocked_unsafe_url`/`no_website`.

## EVIDENCE
- idempotency: YES. Unique index on `(account_id, source_url, evidence_type, normalized_value)`.
- multiple same-type facts: YES. Multiple emails or phones on the same page survive since they have distinct `normalized_value`s.
- normalization: YES.

## CONTACTS
- generic email: Extracted and marked correctly via `isGeneric`.
- named email: Does NOT blindly assign `isPersonalOrNamed: true` for newly discovered non-generic emails without evidence. Set to `false`.
- phones: Extracted phones are now persisted as `type="phone"` in `contact_points`.

## ROLES
- role signal: Extracted as `role_signal` when only a role is mentioned.
- named role: Extracted as `named_role` with a specific person name (identified by capital-cased words preceding the role) when available.

## DOMAIN SAFETY
- SSRF: Handled safely via `safeFetchPage` and `DomainFetchCache`.
- redirect: Manual redirect bounds remain safe.
- registrable-domain boundary: Enforced in the crawler to ensure URLs never cross into platforms like Facebook, Instagram, etc. by asserting `normalizeDomain(resolved) === normalizeDomain(root)`.

## QUALITY
- Tests: PASS
- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Vercel: PASS (Dry-run mode remains active)
