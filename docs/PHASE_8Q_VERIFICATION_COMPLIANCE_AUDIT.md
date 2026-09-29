# PHASE 8Q VERIFICATION + COMPLIANCE AUDIT

## Inspected Components
- **Schema (`compliance.ts`, `contacts.ts`)**: Defines `verificationJobs` for the queue, `emailVerifications` for durable cache, `contactPoints` with `verificationStatus`, and `complianceDecisions`.
- **Readiness (`outreach-readiness-service.ts`)**: `OutreachReadinessService` acts as the canonical source of truth for checking if a candidate is ready. It enforces hard rules like checking the verification status and compliance decision.
- **Provider (`millionverifier-provider.ts`)**: Adapter exists mapping MillionVerifier API to domain codes (`valid`, `catch_all`, `invalid`, etc.).
- **Cache (`email-verification-cache.ts`)**: Defines a caching wrapper around the provider, currently featuring an in-memory implementation for tests.

## Identified Gaps
1. **Verification Queue Lifecycle**: No runner currently exists to dequeue `verification_jobs`, pass them to `MillionVerifier`, store them in `emailVerifications` cache, and update `contactPoints`.
2. **Database Cache Store**: The `EmailVerificationCacheStore` interface needs a real Neon-backed implementation wrapping the `emailVerifications` table.
3. **Job Insertion**: There is no automatic trigger or cron step that finds `analyzed_qualified` accounts with `unverified` emails and inserts jobs into `verification_jobs`.
4. **Compliance Service**: A concrete Neon-backed compliance service is needed to persist rules into `complianceDecisions`.
5. **Contact Selection**: We need logic to prioritize and select exactly one contact per account, storing it as `selectedContactPointId` in `campaign_memberships`.

## Conclusion
The data model and domain rules are largely in place. The task is to connect them into a working backend runner pipeline (dequeue -> verify -> update contact -> select contact -> run compliance decision -> evaluate readiness) ensuring `outreach_ready` is only achieved when all strict constraints pass.
