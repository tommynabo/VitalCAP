# services/verification

Candidate processing persists discovered contact points and enqueues durable
verification jobs; it does not wait on provider requests. The verification
cron claims jobs, uses the workspace/provider/version-scoped cache, persists
the current verdict and append-only evidence, then reevaluates compliance.
Transient provider failures are deferred with backoff; `unknown` stays
ineligible and is rechecked after its short cache window.

`evaluateContactEligibility` is the central endpoint policy. Only `valid` is
eligible by default. `catch_all` requires `EMAIL_VERIFICATION_ALLOW_CATCH_ALL=true`;
`risky`, invalid, disposable, bounced, unknown, and unverified endpoints are
not ready. Compliance, suppression, and account-level outreach dedup remain
separate additional gates.
