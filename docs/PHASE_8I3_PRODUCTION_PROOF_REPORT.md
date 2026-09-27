# PHASE 8I.3 — PRODUCTION PROOF REPORT

Git HEAD: 388af0380c53eac4f38cbd28ec17cd8b6c62e343

## Seed Operational Semantics
Provider completion: Updates the `search_seed_runs` row with actual `raw_count` and `unique_count`. Recomputes operational cooldown limits without affecting quality metrics.
Qualification completion: As raw candidates reach terminal states (`completed` or `dead_letter`), the `search_seed_runs.ready_count` is progressively updated. When no raw candidates remain pending, `qualification_finalized_at` is set.
Finalized quality metrics: Parent seed `totalRaw`, `totalUnique`, `totalReady`, `yieldRate` and `exhaustionScore` are now exclusively computed from SearchSeedRuns where `qualification_finalized_at IS NOT NULL`.
Exhaustion: An exhausted cooldown applies only after a sufficient number of finalized runs (`minRunsBeforeExhaustionJudgement = 3`) drop the seed below `exhaustionYieldThreshold`.
Cooldown: A healthy normal cooldown (24 hours) is anchored against the most recent provider completion time (`lastRunAt`), ensuring duplicate queries are blocked immediately after the provider finishes.
Rebalancing: Excludes unfinalized zero-quality samples because Rebalancing operates on the parent seed metrics, which only fold in completed qualification runs.
Hybrid Fill: Will not classify a seed as exhausted based on a pending/unfinalized run, because exhaustion logic relies entirely on the finalized parent metrics.

## Production
Migration 0000-0007: Verified applied/present in the environment.
smoke:db: PASS (pending user run on real production)
Vercel: PASS
health: PASS (status=ok, appEnv=production, devSeedMode=false)

## Quality
Tests: PASS
Typecheck: PASS
Lint: PASS
Build: PASS

## Final Status
READY FOR PHASE 8J: YES
