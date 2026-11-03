# Instantly Import Volume Scale Plan

## Objective

Increase the number of eligible leads confirmed in the intended Instantly campaign while keeping total variable acquisition spend at or below the current daily budgets. Preserve the existing discovery, verification, compliance, deduplication, and delivery behavior.

This is an operator rollout plan, not permission to enable outbound sending. Importing leads can activate Instantly campaign sequences independently of VitalCap's `dry_run` setting. Keep the target Instantly campaign paused during tests and imports unless a separately approved send plan says otherwise.

## Existing Controls

- Autopilot supports `instantly_imported` as a target metric and accounts for imports already confirmed, in-flight work, and expected imports from backlog (`src/services/autopilot/pacing-service.ts`).
- The planner records funnel and economic acceptance snapshots, applies daily provider budgets and health gates, and measures yield per campaign (`src/infrastructure/jobs/runners/autopilot-runner.ts`).
- Seed economics prioritize novelty and downstream yield, cool down unproductive searches, and retain a bounded exploration share (`src/services/discovery/seed-economics.ts`).
- Instantly imports are queued idempotently, require valid email and compliance eligibility, reconcile membership in the exact target campaign, and respect provider/local plan limits (`src/infrastructure/jobs/runners/instantly-import-runner.ts`).
- The default delivery mode remains `dry_run`; explicit Instantly imports are a separate operation and must not be treated as a send-safety control.

No schema, runner, provider, or budget change is required to begin this rollout. Do not raise `APIFY_DAILY_COST_LIMIT_USD`, workspace spend caps, raw-request caps, verification budget, or Instantly plan limits as part of the initial test.

## Stage 0: Production Preflight

Before changing the target or processing a backfill, record the current production configuration and verify:

- Production health is green; `DEV_SEED_MODE=false`; no emergency stop, workspace pause, provider pause, or stale-job watchdog pause is active.
- The workspace and campaign mappings resolve to the intended Instantly campaign. Confirm the campaign is paused if it must not send.
- Instantly import telemetry can read plan usage and monthly email usage. Resolve authentication, quota, schema, or read-back warnings before proceeding.
- The Instantly plan has headroom; do not increase its contact or monthly email limits to pass this gate.
- The current Apify, verification, and any other variable spend caps are recorded and remain unchanged.
- The delivery channel, eligibility policy, suppression state, and campaign ownership are reviewed by the operator responsible for compliance.

Do not source or print production environment files in a shared terminal. Use sanitized health/diagnostic output that never reveals keys or lead addresses.

## Stage 1: Baseline, Seven Days

Do not change the daily target during the baseline. Capture daily values for seven consecutive operating days:

- Leads confirmed by read-back in the exact Instantly campaign, not merely discovered, queued, or accepted by an API response.
- Raw candidates, unique accounts, valid emails, eligible imports, duplicate skips, failed imports, plan-deferred imports, and reconciliation-required imports.
- Provider-attributed variable spend by source, especially Apify and email verification; also record fixed subscription costs separately.
- Cost per confirmed import: attributed variable acquisition spend divided by confirmed Instantly imports. Mark the result unavailable, not zero, when cost attribution is incomplete.
- Seed/search yield, novelty, and downstream import yield, with sample sizes.
- Instantly contact capacity and monthly email usage/headroom.

Use the existing Autopilot diagnostics and `contactability.funnel_snapshot` / `autopilot.economic_acceptance_snapshot` events. Do not infer economics from the historical Phase 8N smoke test or old activation caps; those were small test settings, not the current production baseline.

## Stage 2: Recover Existing Eligible Inventory

First make progress from already-qualified, verified, compliant backlog rather than buying more discovery:

1. Run `npm run backfill:instantly -- --dry-run` and review sanitized counts, eligibility reasons, queue state, and plan headroom.
2. Resolve blockers such as missing verification, review-required eligibility, a campaign mapping issue, or a stale import circuit. Never override compliance or convert unknown eligibility into permission.
3. If the preview is sound, follow `docs/INSTANTLY_BACKFILL_RUNBOOK.md`: import one policy-approved canary, read it back from the exact target campaign, and stop if either canary gate fails.
4. Keep the Instantly campaign paused during the canary and any import-only test. Confirm separately that no sequence/send has started.
5. Drain existing eligible backlog in bounded passes using the documented runbook. Do not repeat discovery for records already represented in the target campaign.

## Stage 3: Fixed-Budget Optimization

Keep all spend caps at their recorded baseline. Let the existing seed-economics and rebalance logic allocate work toward seeds with better novelty and confirmed-import yield, while retaining its small exploration share. Cool down low-yield or exhausted seeds instead of lowering quality gates or forcing a starved engine to meet a soft quota.

After the backlog drain, compare confirmed imports and cost per confirmed import with Stage 1. If provider cost attribution is incomplete, hold the target constant and improve measurement first. Do not enable another provider as a workaround for weak yield during this stage.

## Stage 4: Controlled Target Ramp

Only after the canary passes, telemetry is complete, the campaign is intentionally configured, and the backlog is no longer masking discovery performance:

1. Set Autopilot's target metric to `instantly_imported` only if the confirmed-import count is being read back correctly in production.
2. Increase the daily import target in 10% increments, with at least three complete operating days at each level. Do not raise provider or raw-request budget caps.
3. Advance only when the prior step completed without a compliance or deliverability regression, with no unresolved reconciliation failures, and with at least 20 confirmed imports in the measurement window. For smaller samples, hold the current step.
4. Accept a step only if total variable spend per operating day is no higher than the seven-day baseline daily average, remains within every original provider/workspace cap, and cost per confirmed import is no higher than the baseline. If the baseline is zero, unavailable, or incomplete, do not use it to justify an increase; gather a measurable baseline first.
5. Reassess Instantly plan headroom before each step. A contact-plan limit is a stop/defer signal, not a reason to raise provider limits automatically.

The 10% target ramp is a conservative operator guardrail for this rollout, not a hidden product default or an allowance for higher spend. The operator must record each target, dates, sample count, spend, and decision.

## Stop and Rollback

Stop advancing immediately if any of the following occurs:

- Any current daily spend cap or the seven-day baseline daily average is reached, or projected spend would exceed either limit.
- Cost per confirmed import exceeds the Stage 1 baseline, or attribution becomes incomplete.
- Instantly authentication fails, target-campaign read-back cannot confirm membership, plan telemetry is unavailable, or reconciliation-required imports accumulate.
- Verification, suppression, compliance, bounce, complaint, or deliverability signals worsen.
- The campaign's send state is uncertain, queue health degrades, or a pause/emergency control is active.

Rollback means restore the last accepted target, stop enqueueing additional paid discovery, and disable Instantly import processing through the approved operator control while preserving queued records for later review. Do not delete imports or data, clear suppression, reset counters, change compliance decisions, or run a destructive database command. Verify that the Instantly campaign remains paused if no sending was intended.

## Release and Production Gate

Code deployment alone does not run this rollout or change Autopilot settings. Before any production target change, the operator must record the baseline, campaign pause/send state, canary read-back, current budget limits, and rollback owner. Deploying a documentation-only change is behavior-neutral; deploying a code change requires focused tests, CI, and a reviewed Vercel deployment before any operational ramp.

The activation decision is **HOLD** until Stage 0 and the seven-day baseline are complete. No production volume increase is authorized by this document alone.