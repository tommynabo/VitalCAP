# PHASE 8I.3 FINAL SEED AUDIT

## Context
This audit addresses the provisional SearchSeed quality bug and fixes operational scheduling vs finalized-quality semantics.
Currently, provider ingestion sets readyCount=0 and immediately recomputes exhaustion, which is semantically incorrect because processing hasn't run yet.

## Identified Issues
1. Provider ingestion treats readyCount=0 as finalized qualified yield.
2. Operational `lastRunAt` and quality `qualificationFinalizedAt` (to be added) need separation.
3. Rebalancing and Hybrid Fill need to ignore unfinalized runs.

## Action Plan
1. Schema updates for SearchSeedRun to add `qualificationFinalizedAt`.
2. Update provider run ingestion to NOT recompute exhaustion for the seed from the provisional readyCount.
3. Update Processing finalization to compute finalized `readyCount` and `qualificationFinalizedAt`.
4. Update SearchSeed recomputation logic to aggregate only finalized runs.
5. Update rebalancing and hybrid-fill planners.
6. Write regression tests.
