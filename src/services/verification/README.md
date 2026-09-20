# services/verification

`acceptance-policy.ts` implemented in Phase 1 (Prompt 1 §1.6):
campaign-configurable `isContactPointAcceptable` check against the abstract
`VerificationStatus` set — no provider-specific assumptions.

The email verification **provider adapter** itself (batching, TTL caching,
cost/result tracking) is Phase 2 (Prompt 2 §2.7) and is not implemented yet.
