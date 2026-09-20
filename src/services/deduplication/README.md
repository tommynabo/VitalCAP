# services/deduplication

Owner: Phase 1 (Prompt 1 §1.2).

Will host `DeduplicationService` implementing strong signals (Google Place ID,
normalized domain, normalized phone) and composite/fuzzy signals (name +
postal code, name + street address) for account dedup, plus contact-level
dedup (normalized email/phone/LinkedIn URL, name+account composite). Merge
decisions above a confidence threshold only, with an audit trail — never a
silent automatic merge on weak fuzzy evidence.

Deliberately empty in Phase 0: reference lessons from ApexEngine's
`DeduplicationService` (see `docs/REFERENCE_AUDIT.md`) inform this design but
are not copied.
