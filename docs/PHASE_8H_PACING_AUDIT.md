# Phase 8H Pacing Audit

## Scope

Phase 8H schedules only Maps Fast discovery orders for the `qualified` target metric. It does not activate rebalancing, Hybrid Fill, Maps Deep, SERP, LinkedIn, or outreach sending.

## Control Path

- `getAutopilotPacingState()` aggregates today's qualified accounts, raw candidates, processing jobs, provider runs, Apify spend, historical yield, and provider health from Neon.
- `computeAutopilotPacing()` remains pure and produces the shared pacing snapshot used by the dashboard and cron.
- `allocateMapsFastRawNeed()` creates proportional per-campaign orders with a 15-minute idempotency key.
- Discovery jobs carry `desiredRawCount`; the runner bounds seeds and requested items, and Compass receives that count as `maxCrawledPlacesPerSearch` subject to the provider maximum.
- Generic discovery queueing remains a compatibility no-op. The Autopilot cron is the only scheduling path for new Phase 8H work.

## Safety Checks

- Paused and emergency-stopped workspaces do not schedule orders.
- Orders are bounded to the remaining pacing need and provider limits.
- Existing provider-run reservation and idempotency controls remain in force.
- No production database migration or destructive operation was run in this phase.

## Evidence

- `npm run typecheck`: pass
- `npm run lint`: pass
- `npm test`: 385 passed, 7 skipped, 1 test file skipped
- Maps provider and engine focused tests: 7 passed

## Outstanding

Production Neon/Vercel verification was not available in this environment. Production status must remain unclaimed until cron authentication, live provider configuration, database counts, Apify budget enforcement, and deployed UI/API behavior are checked against the production project.