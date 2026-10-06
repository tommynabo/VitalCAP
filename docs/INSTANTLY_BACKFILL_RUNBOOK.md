# Instantly Historical Backfill

The operator command drains historical work through the production verification and Instantly runners. It never prints lead addresses or secret values.

## Preview

```sh
npm run backfill:instantly -- --dry-run
```

Preview is the default when no mode is supplied. It reads sanitized counts only and performs no database or provider writes.

## Canary Gate

Before bulk execution, import one policy-approved lead to campaign `055534c5-c3e3-414f-b140-f4770b293c00` and read it back from that exact target campaign. Continue only after `CANARY_WRITE=PASS` and `CANARY_VISIBLE_IN_TARGET=YES`. If either check fails, stop and investigate; presence elsewhere in the Instantly workspace is not success.

## Execute

```sh
npm run backfill:instantly -- --execute
```

Any remote database is treated as production for write safety and requires a second explicit confirmation:

```sh
npm run backfill:instantly -- --execute --production
```

Execute requires the target campaign ID, MillionVerifier, Instantly, `DEFAULT_DELIVERY_MODE=dry_run`, `AUTO_SEND` disabled, and (for a remote database) explicit approval of the versioned B2B email policy. The last gate prevents a channel classification from being mistaken for legal approval.

The command prints one JSON progress record per pass, processes verification and imports in bounded batches, and stops after two passes with no progress, provider failure, plan exhaustion, a database error, or the iteration limit. Exit code `0` means eligible work reached terminal states; a nonzero exit reports a blocker.

Plan-limited leads remain durably marked `deferred_due_to_plan_limit`; increase capacity or wait for capacity, then rerun. A 401/403 Instantly circuit remains open until an authenticated owner reset is performed through the admin circuit-control path after credentials are corrected.

To stop safely, interrupt the local process. Completed verification/import outcomes remain persisted; active leases expire and subsequent runs reuse idempotency keys. Rerun preview before resuming. A second execute is expected to add no duplicate target-campaign leads.

If progress stalls, inspect the reported verification pending/processing/provider-disabled counts, eligible valid contacts, import pending count, circuit state, and plan-deferred count. `unknown` channel eligibility and unapproved compliance decisions remain review-required; the drain does not fabricate eligibility or approval.