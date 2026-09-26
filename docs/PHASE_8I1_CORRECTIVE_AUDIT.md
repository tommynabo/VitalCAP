# PHASE 8I.1 Corrective Audit

Date: 2026-09-26
Starting HEAD: 1830c2e

## Confirmed Findings

- Production validation required APP_ENV, DEV_SEED_MODE, DATABASE_URL and CRON_SECRET, but did not require Neon Auth configuration or APIFY_API_TOKEN.
- `/api/health` did not expose safe Auth and Apify configuration booleans.
- The authenticated dashboard layout could be evaluated during build-time collection.
- Migration 0006 created a partial unique index while repository insertion used `ON CONFLICT (idempotency_key)` semantics.
- `smoke:db` stopped at migration 0005 and did not prove Phase 8I columns/indexes.
- Zero provider calls returned `unknown`; capability gating treated every non-healthy state as unavailable, blocking first use.
- Pacing calculated work outside the operating window and the runner had no explicit scheduling backstop.
- Apify checked only the total daily limit and passed the full batch cap even when the remaining daily budget was smaller.
- Search seed ingestion finalized ready count at zero before processing and had no durable raw-to-seed/provider/account provenance.
- Historical pacing yield joined campaign records without exact raw-to-account attribution.
- Hybrid Fill returned exhaustion before bootstrapping an approved expansion catalog.
- Rebalance cooldown read the newest workspace decision globally rather than scoping it to the relevant campaign pair.

## Scope Exclusions

No LLM, Serper activation, MillionVerifier activation, Instantly activation, SMS, multi-actor Apify routing, live outreach, or paid production run was enabled.

## Local Evidence

- Focused environment, health, provider, pacing, capability, and Hybrid Fill tests pass.
- Full suite: 402 passed, 7 skipped.
- Typecheck: pass.
- Lint: pass.
- Production build: pass; authenticated dashboard routes are dynamic.

## Production Evidence Gaps

No production DATABASE_URL, Neon project verification, Vercel environment verification, Apify token, deployed alias, production health response, or production migration smoke was available in this session. No production migration was run.

## Corrective Design

Migration 0007 is additive and follows 0006. It normalizes the rebalance unique index, adds raw candidate seed/provider/account provenance and indexes, and adds a qualification finalization marker. The repository now writes provenance at ingestion, account attribution after processing, and recomputes seed qualification from persisted records.
