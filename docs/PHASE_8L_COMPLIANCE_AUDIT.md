# Phase 8L Compliance Audit

## 1. `src/services/compliance/compliance-gate.ts`
Current `ComplianceGate` is implemented via `SuppressionAwareComplianceGate` which is a pure function abstraction that merely evaluates an in-memory array of `suppressionEntries()` against `ChannelEligibilityStatus`.
- **Missing**: It is not a persistent operational decision layer. It does not record `compliance_decisions` in the database, has no `policy_version`, and doesn't handle `review_required` statuses explicitly for unknown endpoints.
- **Action**: Needs to be replaced or wrapped by a `PersistentEligibilityService` that evaluates, makes a decision, and persists `compliance_decisions` to the database.

## 2. `src/services/compliance/suppression-service.ts`
Current `checkSuppression` evaluates if a contact point or account is suppressed based on an in-memory array.
- **Missing**: True DB-level idempotent operations for inserting suppression entries.
- **Action**: Update to rely entirely on `suppression_entries` DB queries/mutations.

## 3. Outreach Orchestrator & Channel Router
- Currently rely on the pure `ComplianceGate`. Needs to interact with `PersistentEligibilityService`.

## 4. Verification & Persistence
- Missing `email_verifications` cache and `verification_jobs` schema.

## Conclusion
The current compliance layer is a structurally sound base but lacks the required persistence, auditability (policy versions), and strict DB-backed suppression checks. We must build `compliance_decisions` and the `PersistentEligibilityService` to enforce dry-run safety and exact outreach-ready requirements.
