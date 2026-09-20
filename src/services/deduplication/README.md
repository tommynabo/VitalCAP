# services/deduplication

Implemented in Phase 1 (Prompt 1 §1.2):

- `account-dedup.ts` — strong signals (Google Place ID, normalized domain,
  normalized phone) always win outright; composite/fuzzy signals (name +
  postal code, name + address, name + geo proximity) only auto-merge at/above
  a configurable confidence threshold, otherwise they're flagged for human
  review (`flag_for_review`), never silently merged.
- `contact-dedup.ts` — strong (email/phone/LinkedIn URL) and composite
  (full name + same account) contact-level dedup. Distinct named contacts on
  the same account are never conflated.
- `outreach-dedup.ts` — prevents duplicate sends via
  `contact_point + campaign + channel + cooldown`, enforces the account-level
  concurrency lock (never contact the owner and `info@` of the same account
  simultaneously by default), and checks active suppression first.
- `merge-record.ts` — builds the `AccountMergeRecord` audit entry every merge
  decision (including fuzzy ones) must produce.

Reference lessons from ApexEngine's `DeduplicationService` (see
`docs/REFERENCE_AUDIT.md`) informed this design but were not copied.
