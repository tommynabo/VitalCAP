# Phase 4 Report — AI Setter, Reply Classification, Human Review, Learning Loop

Source of truth: `VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`, Prompt 4 (§4.1–§4.12).

## Summary

Phase 4 implements the reply-handling layer: idempotent reply ingestion, a deterministic pre-router that
unconditionally suppresses unsubscribe/do-not-contact replies before any LLM call, a whitelisted
`SetterPromptContext` builder, a mock `LLMProvider` producing Zod-validated structured output with a
retry-once-then-human-fallback path, independent post-generation guardrails against invented claims and
non-approved commercial negotiation, a human review service covering all six review actions, feedback
analytics for the learning loop, a fully-built-but-unwired autonomy policy engine, a warm follow-up
scheduler distinct from Phase 3's cold sequence, and two new UI pages (Reviews inbox, Setter dashboard).
No real LLM API, no live Supabase project, and no real external provider was touched — everything runs
against in-memory seed data and pure functions, matching the standing safety posture from Phases 0–3.

## Implemented files

**Domain**
- `src/domain/conversations/types.ts` — extended: `Conversation.providerThreadId`, `SetterDraft.
  detectedFactsRequested`/`suggestedNextAction`, `SetterFeedback.meetingOutcome`/`qualified`/`lostReason`.
- `src/domain/providers/types.ts` — extended with `SetterPromptContext`, `SetterClassificationOutput`,
  `LLMProvider`.

**AI Setter services (`src/services/setter/`)**
- `pre-router.ts` — deterministic regex-based detection of 9 categories (unsubscribe, do-not-contact,
  hard negative, out-of-office, bounce/system message, meeting-already-booked, wrong-person/forward
  request, contact-details-supplied, automated spam); unsubscribe/do-not-contact force `suppress: true`.
- `context-builder.ts` — builds a whitelisted, capped `SetterPromptContext` (max 10 recent messages, max
  5 feedback notes) — never a raw DB dump.
- `setter-output-schema.ts` — strict Zod schema for the LLM's structured output contract, over the exact
  19-value `SetterBranch` enum.
- `classify-and-draft.ts` — calls the `LLMProvider`, Zod-validates, retries once with a repair flag on
  failure, falls back to a `HUMAN_REQUIRED` draft on double failure, then applies guardrails.
- `guardrails.ts` — independently re-checks the draft against `Offer.forbiddenClaims` (medical/
  therapeutic, certification, legal/regulatory, pharmacy-performance) and approved commercial/product
  fact keys; force-escalates non-approved commercial-negotiation asks.
- `reply-ingestion.ts` — idempotent reply normalization (dedup by `providerMessageId`), reusing Phase 3's
  `verifyWebhookSignature`.
- `review-service.ts` — applies the six review actions (approve, edit & send, reject, no reply needed,
  escalate, suppress); the only function that can move a conversation to `"sent"`.
- `feedback-analytics.ts` — branch accuracy, approval/edit/rejection rate, positive-reply→meeting rate,
  average edits, confidence calibration, per-branch performance table.
- `autonomy-policy.ts` — `canAutoSend()` evaluator (branch allowlist, confidence threshold, risk flags,
  contact type, campaign toggle); `AUTO_SEND_ENABLED = false as const`, never imported by any send path.
- `warm-followup-service.ts` — separate warm follow-up queue (3-day delay) for interested-but-not-booked
  leads; pauses on reply/meeting/unsubscribe/human ownership.
- `setter-orchestrator.ts` — composes pre-router → suppression check → context builder → classify-and-
  draft for one incoming reply.
- `simulate-setter-day.test.ts` — integration test: idempotent replay, unsubscribe suppression with zero
  LLM calls, pre-existing suppression blocking the LLM, full classify→draft→review→warm-followup flow,
  guardrail-triggered escalation.

**Mock providers**
- `src/infrastructure/providers/llm/mock-provider.ts` — `MockLLMProvider` (deterministic keyword
  classification across 14 branch rules + template drafting, reusing the shared `deterministic-fixtures.ts`
  pattern).

**Seed data** (`src/lib/seed/dev-seed.ts`)
- `seedConversations`, `seedConversationMessages`, `seedSetterDrafts`, `seedSetterFeedback`,
  `seedMeetings`.

**UI**
- `src/app/(dashboard)/reviews/page.tsx` — three-column human review inbox (conversation list / thread /
  AI analysis + draft + 5 review action buttons).
- `src/app/(dashboard)/setter/page.tsx` — AI Setter dashboard (KPI row + branch performance table, backed
  by `feedback-analytics.ts`).

**Docs**
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/PROVIDERS.md`, `docs/SETTER.md`,
  `docs/IMPLEMENTATION_PLAN.md` — updated with Phase 4 modules and status.
- `docs/DECISIONS.md` — ADR-015 (pre-router runs before, and unconditionally overrides, any LLM call),
  ADR-016 (guardrails re-validate LLM output rather than trusting self-reported flags), ADR-017
  (autonomy policy engine built but structurally unwired from any send path), ADR-018 (warm follow-up is
  a distinct queue from Phase 3's cold sequence).

## Architectural decisions

See ADR-015 through ADR-018 in `docs/DECISIONS.md` for full rationale. In short: (1) suppression
detection runs before, and can never be overridden by, an LLM call; (2) guardrails independently
re-check the LLM's draft text rather than trusting its own `needsHuman`/`riskFlags`; (3) the autonomy
policy engine has no import path to any send action — enabling autosend later requires new code, not a
flag flip; (4) warm follow-up (post-reply, interested leads) is kept structurally separate from Phase 3's
cold sequence (pre-reply cadence) to avoid conflating two different state machines.

## Tests executed

```
npm run lint          → clean
npx tsc --noEmit -p . → clean
npx vitest run         → 57 files, 306 tests passed (76 setter-scoped tests added this phase:
                         pre-router, context-builder, setter-output-schema, guardrails, mock LLM
                         provider, classify-and-draft, reply-ingestion, review-service,
                         feedback-analytics, autonomy-policy, warm-followup-service, and the
                         simulate-setter-day integration test)
npm run build          → succeeds, all 15 routes generated including /reviews and /setter
```

## External services mocked

- `LLMProvider` — mock only (`MockLLMProvider`), no API key used, no real HTTP/model call.
- Reply webhook signature verification reuses Phase 3's HMAC-SHA256 `verifyWebhookSignature` — no
  external service.

No `mcp_supabase_*` tool was used this session, and no real Supabase project was touched, per the
standing project safety rule.

## Known limitations / explicitly deferred

- No real reply webhook HTTP route exists yet (`services/setter/reply-ingestion.ts` and
  `setter-orchestrator.ts` are pure functions, not wired to an API route) — the same "services-first,
  route-wiring-later" pattern used in Phases 1–3.
- The Reviews inbox's review-action buttons are demo-only (set local component state) since there is no
  database yet to persist a real decision — matches Phase 0's dev-seed-mode UI convention.
- Calendar/meeting-booking integration (`CalendarProvider`) remains unallocated, per Prompt 4 scope.
- Migrations for `conversations`/`conversation_messages`/`setter_drafts`/`setter_feedback`/`meetings`
  remain unapplied to any live Postgres instance (same standing decision as Phases 1–3 — see ADR-007).
- Autonomy (autosend) remains fully disabled by design; `autonomy-policy.ts` is tested in isolation but
  not reachable from any code path, per Prompt 4 §4.9 and ADR-017.

## Prompt 4 acceptance checklist (§4.1–§4.12)

| § | Requirement | Status |
|---|---|---|
| 4.1 | Idempotent reply ingestion, thread matching | ✅ `reply-ingestion.ts` |
| 4.2 | Deterministic pre-router, never overridden by LLM | ✅ `pre-router.ts` + `setter-orchestrator.ts` |
| 4.3 | `LLMProvider` interface + `SetterPromptContext` contract | ✅ `domain/providers/types.ts` |
| 4.4 | Whitelisted, bounded prompt context (no raw DB dumps) | ✅ `context-builder.ts` |
| 4.5 | Structured output, Zod validation, retry + human fallback | ✅ `setter-output-schema.ts`, `classify-and-draft.ts` |
| 4.6 | Guardrails — no invented claims, escalate negotiation | ✅ `guardrails.ts` |
| 4.7 | Human review actions (approve/edit/reject/no-reply/escalate/suppress) | ✅ `review-service.ts` |
| 4.8 | Structured feedback for the learning loop | ✅ `SetterFeedback` fields + `review-service.ts` |
| 4.9 | Autonomy policy engine, disabled by default | ✅ `autonomy-policy.ts`, `AUTO_SEND_ENABLED = false` |
| 4.10 | Reviews inbox UI (3-column) | ✅ `reviews/page.tsx` |
| 4.11 | Setter dashboard UI (KPIs, branch performance) | ✅ `setter/page.tsx` |
| 4.12 | Warm follow-up scheduler, separate from cold sequence | ✅ `warm-followup-service.ts` |

**Overall: PASS.**

## Next-phase recommendation

Proceed to Prompt 5 (full frontend / UX / visual system) when instructed — not started this session.
