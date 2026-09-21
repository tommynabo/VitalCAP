# Phase 3 Report — Outreach Infrastructure, Email/SMS, Channel Router, Suppression

Source of truth: `VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`, Prompt 3 (§3.1–§3.12).

## Summary

Phase 3 implements the deterministic outreach layer: universal suppression, a `ComplianceGate`, a
`ChannelRouter` (endpoint preference + one-active-path concurrency + cooldown), sender pool capacity/
health management, a channel mix planner (desired vs. actual, e.g. 125 email / 125 SMS), a cold/warm
sequence service with reply-pause and bounce-cancel, mock `EmailDeliveryProvider`/`SmsDeliveryProvider`
adapters (Instantly-shaped email + generic SMS), a minimal non-LLM message renderer, idempotent webhook
event ingestion, and a dry-run orchestrator tying all of it together. No live Supabase project and no
real external provider was touched — everything runs against in-memory seed data and pure functions,
matching the standing safety posture from Phases 0–2.

## Implemented files

**Domain**
- `src/domain/providers/types.ts` — extended with `EmailDeliveryProvider`, `SmsDeliveryProvider`, and
  supporting request/result/status-event types.

**Normalization**
- `src/lib/normalization/classify-phone-type-es.ts` + barrel export — heuristic Spanish phone-type
  classifier (mobile `6`/`7`, landline `8`/`9`), used to avoid assuming every discovered phone is
  SMS-capable.

**Compliance (`src/services/compliance/`)**
- `suppression-service.ts` — `checkSuppression`/`addSuppression`, workspace-wide, idempotent (adding the
  same contact-point/reason twice never duplicates).
- `compliance-gate.ts` — `SuppressionAwareComplianceGate`, the single implementation of
  `domain/compliance`'s `ComplianceGate`. Suppression always wins; channel eligibility is evaluated
  per-channel and is never transitive (email-eligible ≠ SMS-eligible).

**Outreach (`src/services/outreach/`)**
- `channel-router.ts` — `routeAccountToEndpoint`: ranks eligible, non-suppressed contact points by
  Phase 1's `priorityScore` (reusing the existing owner→info@ ladder rather than re-encoding it),
  enforces one active outreach path per account by default, and an account cooldown window.
- `sender-pool-service.ts` — mailbox/domain capacity (`dailyCapacity - sentToday`, never hardcoded) and
  health gating (bounce rate, health score, paused status, domain status).
- `channel-mix-planner.ts` — desired-vs-sent-vs-capacity allocation per channel with shortfall
  reporting; never selects accounts itself, so it can never be used to justify bypassing suppression.
- `sequence-service.ts` — cold/warm step gating: any reply pauses all further steps; bounce/unsubscribe
  cancels the path outright; otherwise gates on a per-step delay.
- `message-renderer.ts` — whitelisted, `Offer`-backed `{{placeholder}}` substitution only; unknown
  placeholders are left untouched and reported, never fabricated.
- `outreach-event-ingestion.ts` — HMAC-SHA256 webhook signature verification (timing-safe compare) +
  dedup by `providerEventId` (replay-safe).
- `outreach-orchestrator.ts` — `runOutreachDryRunCycle`, composing all of the above; structurally never
  imports a delivery provider (see ADR-012).
- `simulate-outreach-day.test.ts` — integration test exercising the composed dry-run cycle, a bounce
  triggering suppression, a reply pausing a sequence, and idempotent webhook replay.

**Mock providers**
- `src/infrastructure/providers/instantly/mock-provider.ts` — `MockInstantlyEmailDeliveryProvider`
  (`addLead`/`syncStatus`, Instantly-shaped, deterministic).
- `src/infrastructure/providers/sms/mock-provider.ts` — `MockSmsDeliveryProvider` (`send`/`syncStatus`,
  deterministic segment/cost + status rolls).

**Seed data** (`src/lib/seed/dev-seed.ts`)
- `seedSendingDomains`, `seedMailboxes`, `seedSuppressionEntries`, `seedOutreachQueueItems`,
  `seedOutreachEvents`.

**UI**
- `src/app/(dashboard)/infrastructure/page.tsx` — capacity KPIs, sending domain/mailbox/provider status
  cards, no secrets rendered.
- `src/app/(dashboard)/outreach/page.tsx` — KPI row (scheduled/sent/email-SMS split/bounces/replies/
  opt-outs) plus a filterable queue table (channel/campaign/state).

**Docs**
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/PROVIDERS.md`, `docs/IMPLEMENTATION_PLAN.md` —
  updated with Phase 3 modules and status.
- `docs/DECISIONS.md` — ADR-012 (mock-only, structurally no-live-send orchestrator), ADR-013 (reuse of
  `priorityScore` for endpoint ranking), ADR-014 (defense-in-depth compliance checks at router + gate).

## Architectural decisions

See ADR-012 through ADR-014 in `docs/DECISIONS.md` for full rationale. In short: (1) the dry-run
orchestrator has no import path to a real delivery provider — flipping to live sending requires writing
new code, not flipping a flag; (2) endpoint ranking reuses Phase 1's existing priority score rather than
re-encoding the preference ladder a second time; (3) suppression/eligibility is checked at both the
router (candidate filtering) and the orchestrator (final gate call) for defense in depth.

## Tests executed

```
npm run lint        → clean
npx tsc --noEmit -p . → clean
npx vitest run       → 45 files, 230 tests passed (42 in src/services/outreach + 9 in
                        src/services/compliance + 6 in the two new mock providers + 3 in the
                        phone-type classifier, all added this phase)
npm run build        → succeeds, all 14 routes generated including /infrastructure and /outreach
```

## External services mocked

- `EmailDeliveryProvider` (Instantly-shaped) — mock only, no API key used, no real HTTP call.
- `SmsDeliveryProvider` — mock only, no real gateway.
- Webhook signature verification uses Node's built-in `crypto` (HMAC-SHA256) — no external service.

No `mcp_supabase_*` tool was used this session, and no real Supabase project was touched, per the
standing project safety rule.

## Known limitations / explicitly deferred

- No SMS sender-pool domain model exists yet (only email `Mailbox`/`SendingDomain`); the orchestrator
  takes SMS remaining capacity as a direct input rather than deriving it from a domain type. If a real
  SMS sender-pool concept (numbers, per-number throughput) is needed, it's a natural Phase 3-follow-up or
  Phase 6 hardening item.
- `outreach-dedup.ts`, as originally named in `docs/DATA_MODEL.md`'s Phase 1 addendum, was intentionally
  not created as a single file — its two responsibilities live in `suppression-service.ts` and
  `channel-router.ts` respectively (documented in `docs/DATA_MODEL.md`'s new Phase 3 addendum).
  `docs/IMPLEMENTATION_PLAN.md` and `docs/DATA_MODEL.md` have been updated to reflect the actual module
  names.
- Real live delivery credentials/wiring, AI Setter, and reply-driven autonomy remain entirely out of
  scope for this phase, per Prompt 3 and Appendix C.
- Migrations for `sending_domains`/`mailboxes`/`suppression_entries`/`outreach_events` remain unapplied
  to any live Postgres instance (same standing decision as Phases 1–2 — see ADR-007).

## Prompt 3 acceptance checklist (§3.1–§3.12)

| § | Requirement | Status |
|---|---|---|
| 3.1 | Outreach infrastructure overview / delivery-mode default | ✅ `dry_run` default preserved, orchestrator dry-run only |
| 3.2 | `ChannelRouter` — preference order, one-active-path, cooldown | ✅ `channel-router.ts` |
| 3.3 | `EmailDeliveryProvider` interface + Instantly-shaped mock | ✅ `domain/providers/types.ts` + `instantly/mock-provider.ts` |
| 3.4 | Sender pool capacity/health management | ✅ `sender-pool-service.ts` |
| 3.5 | `SmsDeliveryProvider` interface + phone-type classification | ✅ `domain/providers/types.ts`, `sms/mock-provider.ts`, `classify-phone-type-es.ts` |
| 3.6 | Channel mix planning (desired vs. actual, shortfall) | ✅ `channel-mix-planner.ts` |
| 3.7 | Universal suppression before every send | ✅ `suppression-service.ts` + `compliance-gate.ts` (checked at router and orchestrator) |
| 3.8 | Idempotent webhook ingestion | ✅ `outreach-event-ingestion.ts` |
| 3.9 | Sequence service (cold/warm, reply pause) | ✅ `sequence-service.ts` |
| 3.10 | Infrastructure UI | ✅ `infrastructure/page.tsx` |
| 3.11 | Outreach UI (KPIs, queue, filters) | ✅ `outreach/page.tsx` |
| 3.12 | Render + dry-run orchestrator + integration test | ✅ `message-renderer.ts`, `outreach-orchestrator.ts`, `simulate-outreach-day.test.ts` |

**Overall: PASS.**

## Next-phase recommendation

Proceed to Prompt 4 (AI Setter, reply classification, human review, learning loop) when instructed —
**not started as part of this session**, per the explicit phase-boundary stop instruction.
