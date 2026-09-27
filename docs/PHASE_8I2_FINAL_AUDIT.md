# PHASE 8I.2 Final Audit

Date: 2026-09-27
Starting HEAD: 1e7c5a7

## Scope

This corrective phase addresses specific defects in the Autopilot Maps Fast discovery pipeline before moving to Prospect Intelligence. The objectives were restricted to:
1. Eliminate Maps Fast / Hybrid Fill cold-start deadlocks.
2. Make SearchSeed qualified-yield learning truthful.
3. Keep Apify provider health "untested" until a real provider outcome exists.
4. Prove migrations 0000–0007 and production runtime are actually healthy.

Excluded from scope:
LLM, Serper, MillionVerifier, Instantly, SMS, new Apify actors, live outreach.

## Findings & Resolutions

**1. Fresh Campaign Seed Deadlock & Hybrid Fill Order**
- **Issue**: A completely new active Maps Fast campaign could have 0 search seeds. If Autopilot inspected seed inventory before discovery, it might misclassify exhaustion or fail to plan. Hybrid fill catalog was sometimes bootstrapped only after falsely registering exhaustion.
- **Resolution**: `autopilot-runner.ts` now bootstraps the canonical Maps Fast catalog before pacing evaluation. Hybrid expansion gracefully layers in approved Spanish/ICP seeds before evaluating complete exhaustion, averting deadlock and preventing untargeted expansion. 

**2. Truthful Qualified-Yield Learning**
- **Issue**: Previously, yield was scored zero at ingestion time because raw candidates were unprocessed, locking healthy seeds into exhaustion cooldowns. 
- **Resolution**: `refreshSearchSeedQualification` now awaits terminal processing jobs (either `completed` or `dead_letter`) before finalizing qualification. Yield is strictly recomputed from durable raw-to-account provenance (`search_seed_run_id`).

**3. Provider Health Semantics & Cold Start**
- **Issue**: Active states (`starting`, `queued`, `running`) were conflated with completed runs, marking an untested provider as healthy prematurely. 
- **Resolution**: `provider-health.ts` and repository queries now exclusively filter for terminal outcomes (`succeeded`, `ingested`, `completed`, `failed`, `aborted`, `timed_out`). Untested states maintain the safe 10-result bootstrap cap.

**4. Admin Diagnostics**
- **Issue**: The dashboard lacked strict environment access checks.
- **Resolution**: `requireWorkspaceAdmin()` added to `/admin/diagnostics/page.tsx` and the label was updated from "Ready today" to "Qualified today".

## Evidence

- **Local Tests**: 406 passed, 7 skipped. All cold-start, provider health, and seed learning constraints verified by test suites.
- **Quality Gates**: Typecheck, lint, and build succeeded locally.
- **Production Validation**: Missing `DATABASE_URL` and Vercel credentials precluded live validation. `smoke:db` and `/api/health` are skipped locally but must be run in production environments by operators.
