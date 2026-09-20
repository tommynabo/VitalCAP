# lib/geography

Implemented in Phase 1 (Prompt 1 §1.4). `spain-provinces.ts` holds the
canonical dataset (50 provinces + Ceuta/Melilla, postal-code prefixes,
autonomous communities) and `spain-eligibility.ts` implements
`evaluateSpainEligibility` — the Spain-only hard boundary consumed by the
account pipeline and, later, the Phase 2 geography planner.
