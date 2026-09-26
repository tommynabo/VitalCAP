# Phase 8I Rebalance Audit

## 8H Findings

- Phase 8H had a real pacing snapshot and idempotent Maps Fast orders, but the cron did not execute rebalancing and the legacy pure rebalancer treated unavailable engines as donors.
- The discovery contract carried order size, but Hybrid Fill did not carry a selected seed into execution.
- Provider spend is persisted per provider run; campaign-level cost attribution is not currently exact, so the Phase 8I score treats unknown campaign cost as unknown rather than inventing it.

## Runtime Capability

`buildEngineCapabilities()` is the runtime gate. Maps Fast is available only when Maps is configured, health is healthy, budget remains, and an active Maps Fast campaign exists. Maps Deep is disabled for this phase. SERP and LinkedIn are unavailable unless Serper is explicitly configured; Hybrid Fill is virtual and can only use healthy Maps Fast.

## Rebalance Controls

- Performance uses persisted seed totals: raw, qualified, yield, sample size, exhaustion, and recent run eligibility.
- Score: `0.6 * (0.5 + confidenceAdjustedYield) + boundedCostScore - exhaustionPenalty - queuePenalty`.
- `confidenceAdjustedYield` bootstraps at 15% until the minimum sample is reached.
- Rebalancing moves only uncovered raw capacity, requires a minimum score improvement, and has a 30-minute cooldown.
- Each decision creates an idempotent durable discovery order and stores campaign attribution plus a metric snapshot.

## Hybrid Fill Controls

Hybrid Fill is a deficit rescue planner, not a provider. It activates only for a remaining deficit with late-day pressure, source underperformance, normal allocation exhaustion, or exhausted seed inventory. It uses only approved Spanish geography and ICP category terms, keeps `engineType=maps_fast`, and records `origin=hybrid_fill`.

## Safety

Spain eligibility, campaign status, Autopilot state, provider health, deduplication, Apify workspace/global limits, and per-job limits remain enforced by existing discovery and provider-run paths. No Serper, MillionVerifier, LLM, outreach, or new Apify actor was enabled.

## Production

No paid production campaign was run. Production migration and live verification remain operator gates.