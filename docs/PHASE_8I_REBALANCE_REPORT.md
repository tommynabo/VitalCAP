# Phase 8I Rebalance Report

Capabilities: runtime capability model exposes only configured, healthy, budget-allowed engines; Maps Fast is the current real engine and Hybrid Fill is virtual Maps orchestration.

Performance metrics: persisted seed raw, qualified, yield, sample size, exhaustion and cooldown fields are used. Exact campaign cost is unknown when attribution is unavailable.

Rebalance score: deterministic yield plus bounded cost efficiency, neutral bootstrap confidence, health gate, exhaustion penalty, and queue penalty.

Sample confidence: minimum sample size is 20; small samples are blended toward a 15% neutral yield.

Cooldown: 30 minutes between persisted rebalance decisions per workspace/campaign/window.

Execution: rebalance decisions enqueue bounded `run_engine_batch` discovery jobs with `engineType=maps_fast`.

Hybrid Fill trigger: late-day deficit, normal allocation exhaustion, underperformance, or exhausted seed inventory; never when on pace.

Geography expansion: deterministic approved Spanish population-centre and region list, with seed cooldown and exhaustion ordering.

Category expansion: approved ICP terms only, including farmacia, parafarmacia, herbolario, suplementos and nutrición deportiva.

Seed ranking: eligible seeds first, then lower exhaustion, higher yield, and deterministic query/geography order; requested Hybrid seed is honored by the discovery runner.

Cost: unknown attribution remains unknown; no fabricated cost-per-qualified metric is shown.

Budget: workspace and global Apify limits remain enforced; zero budget creates `target_at_risk_budget` and schedules no paid work.

Provider health: unhealthy Maps Fast creates `target_at_risk_provider` and schedules no rescue work. Deferred providers remain disabled.

Target risk: `on_track`, `recoverable`, `target_at_risk_budget`, `target_at_risk_provider`, `target_at_risk_exhaustion`, and `target_at_risk_time` are deterministic states.

Plan idempotency: discovery job keys and rebalance decision keys are persisted; repeated planning windows do not create duplicate active work.

Attribution: actual source remains Maps Fast; planning origin is `normal`, `rebalance`, or `hybrid_fill`.

UI: Autopilot shows pacing, target risk, Hybrid Fill eligibility, engine health/yield, and rebalance activity without fabricating unavailable cost data.

Tests: full suite passes with 393 tests passed and 7 skipped; Phase 8I planner, capability, Hybrid Fill, rebalancing, seed selection, and provider-bound tests are included.

Typecheck: pass.

Lint: pass.

Build: pass.

READY FOR 8G.2/8H/8I AUDIT: NO, until production migration and deployment verification are performed.