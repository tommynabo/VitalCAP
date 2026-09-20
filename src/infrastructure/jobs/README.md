# infrastructure/jobs

Owner: Phase 2. Durable job runner: atomic claim/lease, exponential backoff
for transient errors, dead-lettering after configured max attempts. Backs
the `discovery_jobs` / `processing_jobs` / `outreach_queue` tables.
