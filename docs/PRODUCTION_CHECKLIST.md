# Production Checklist (Prompt 6 §6.9)

Checklist to complete before any real customer-facing traffic flows through this system. This project
has never been deployed to a live Supabase/Vercel project — every item below is currently **unchecked**
and is written as an actionable step, not a status report. Cross-references point to the doc/decision
that explains *why* each step matters.

- [ ] **Supabase project configured** — a real Supabase project provisioned (not the throwaway local
      Postgres instances used to validate migrations during this phase — see `docs/DECISIONS.md`
      ADR-002/ADR-019).
- [ ] **Migrations applied** — all of `supabase/migrations/0001` through `0006_phase6_hardening.sql`
      applied in order, including the schema/domain-drift fixes and the new
      `uq_outreach_events_provider_event_id` index from this phase (ADR-019 and its addendum).
- [ ] **RLS verified** — every table in `0005_rls_policies.sql` spot-checked with a real anon/
      authenticated-role query against the live project (not just read off the migration file — see
      `docs/SECURITY_REVIEW.md`), confirming cross-workspace access is actually denied.
- [ ] **Auth callback URLs** — Supabase Auth redirect/callback URLs configured for the real production
      domain (and any preview-deployment domains, if used).
- [ ] **Vercel env vars** — every variable in `.env.example` set in the Vercel project (Production
      environment), with `NEXT_PUBLIC_*` vs. server-only vars double-checked against the `.env.example`
      comments (never put `SUPABASE_SERVICE_ROLE_KEY` behind `NEXT_PUBLIC_*`).
- [ ] **`DEV_SEED_MODE=false`** in production — the in-memory dev-seed layer must never be live in a
      real deployment.
- [ ] **Cron secret** — `CRON_SECRET` set and the real cron route (once built) validates it before doing
      any work, so an unauthenticated request cannot trigger a dispatch cycle.
- [ ] **Provider keys** — `MAPS_PROVIDER_API_KEY`, `SERP_PROVIDER_API_KEY`,
      `EMAIL_VERIFICATION_PROVIDER_API_KEY`, `INSTANTLY_API_KEY`, `SMS_PROVIDER_API_KEY`,
      `LLM_PROVIDER_API_KEY` all set with real, tested credentials — per §6.11's rule, do not mark any
      provider "connected" until it has actually been called successfully against the real API (every
      provider in this codebase is currently a mock — see the Provider Matrix in
      `docs/PHASE_6_REPORT.md`).
- [ ] **Webhooks** — real webhook endpoint(s) built and registered with each provider that supports
      delivery/reply webhooks, using `verifyWebhookSignature`
      (`src/services/outreach/outreach-event-ingestion.ts`) with each provider's real shared secret (not
      a shared/test secret).
- [ ] **Instantly campaign mappings** — every VitalCap campaign mapped to the correct Instantly
      campaign ID before any live send is enabled for it.
- [ ] **Sending domains/mailboxes** — real sending domains and mailboxes entered (`SendingDomain`/
      `Mailbox` records), with SPF/DKIM/DMARC configured and verified at the DNS level before any live
      send.
- [ ] **Warmup/capacity entered** — each mailbox's realistic daily send capacity and warmup schedule
      entered accurately (`sender-pool-service.ts` capacity math is only as good as the numbers fed
      into it).
- [ ] **Email verifier** — `EMAIL_VERIFICATION_PROVIDER_API_KEY` set and tested; confirm
      `verifyEmailsWithCache`'s cache TTL is appropriate for the real provider's rate limits/pricing.
- [ ] **Maps/SERP provider** — `MAPS_PROVIDER_API_KEY`/`SERP_PROVIDER_API_KEY` set and tested against a
      real query before enabling Maps Fast/Maps Deep/Google SERP engines for a live campaign.
- [ ] **SMS adapter configured or explicitly disabled** — either `SMS_PROVIDER_API_KEY` is set and
      tested, or the SMS channel is explicitly disabled in every campaign's `desiredChannelMix` (never
      left half-configured and silently attempted).
- [ ] **Booking URL** — `DEFAULT_BOOKING_URL` (and/or each `Offer.bookingUrl`) set to a real, working
      scheduling link before any outreach referencing it goes live.
- [ ] **Approved offer facts reviewed** — every `Offer.approvedCommercialFacts` /
      `approvedProductFacts` / `approvedClaims` / `forbiddenClaims` reviewed and signed off by whoever
      owns the commercial/medical-claims accuracy for VitalCap (the AI Setter's guardrails only enforce
      *consistency* with these facts — a human must ensure the facts themselves are true and compliant
      before they're approved).
- [ ] **Sender identity/signature** — real sender name/role/signature configured per campaign (not a
      placeholder), consistent with what the AI Setter references when drafting replies.
- [ ] **Suppression test** — manually add a test contact to `suppression_entries` and confirm a
      simulated outreach attempt for it is blocked end-to-end (via `checkSuppression`/
      `SuppressionAwareComplianceGate`) before trusting suppression in production.
- [ ] **Dry run passed** — a full day's dry-run cycle (`DEFAULT_DELIVERY_MODE=dry_run`) executed against
      real (not seed) data end-to-end, with the output manually reviewed for correctness (right
      accounts, right contact points, right rendered message content, no unsuppressed contact
      contacted) before ever flipping to `live`.
- [ ] **Emergency stop tested** — the global pause / emergency-stop procedure (`docs/RUNBOOK.md`
      §1) exercised for real at least once against the live deployment, confirming no new job is
      claimed while paused and that in-flight jobs finish safely.

## Known blockers already documented elsewhere (do not go live until resolved)

- **`conversations`/`setter_drafts` schema-vs-domain field gaps** — `docs/DECISIONS.md` ADR-019
  documents fields the Phase 3/4 domain types carry that the current migration's columns don't (e.g.
  `conversations.offer_id`/`provider_thread_id`/`latest_intent`, several `setter_drafts` AI-output
  fields). A follow-up migration closing this gap must land and be validated before `conversations`/
  `setter_drafts` are ever wired to real Supabase reads/writes.
- **No real cron/webhook routes exist yet** — `docs/IDEMPOTENCY_AUDIT.md` and `docs/RUNBOOK.md` both
  note that the duplicate-cron-run and duplicate-webhook protections are verified at the pure-function
  level only; the actual `src/app/api/cron/*` and webhook routes must be built and load-tested for
  real duplicate-delivery behavior before go-live.
- **Pagination not yet implemented** — `docs/PERFORMANCE_REVIEW.md` flags that dashboard list views
  currently render whole dev-seed arrays; must be paginated before real, larger data volumes are wired
  in.
- **No rate limiting** — `docs/SECURITY_REVIEW.md` flags this as required before any public
  webhook/cron route is exposed.
