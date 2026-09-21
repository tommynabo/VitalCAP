# AI Setter — Vitalcap Outreach OS

The AI Setter (Phase 4) turns inbound replies into qualified meetings, human-in-the-loop at launch. This document covers the Phase 0 vocabulary already modeled and what's explicitly deferred.

## What exists today (Phase 0)

`src/domain/conversations/types.ts` defines the shared vocabulary only — no LLM calls, no reply ingestion, no drafting logic:

- **`SetterBranch`** — the initial branch catalog the deterministic pre-router + LLM classifier will assign replies to: `INTEREST`, `SEND_INFO`, `MARGIN`, `PRICE`, `MINIMUM_ORDER`, `PRODUCT_DETAILS`, `EXISTING_SUPPLIER`, `SAMPLES`, `CREDIBILITY`, `NOT_DECISION_MAKER`, `FORWARD_TO_PURCHASING`, `CALL_ME_LATER`, `MEETING_REQUEST`, `LOGISTICS`, `COMMERCIAL_TERMS`, `NOT_INTERESTED`, `UNSUBSCRIBE`, `UNKNOWN`, `HUMAN_REQUIRED`.
- **`ConversationState`** — full state machine (Appendix B) a conversation moves through.
- **`Conversation`**, **`ConversationMessage`** — thread + message history shape.
- **`SetterDraft`** — an AI-proposed reply awaiting human review.
- **`ReviewDecision`** — approve/reject/correct outcome recorded against a draft.
- **`SetterFeedback`** — structured feedback loop data (branch accuracy tracking mentioned in the Reviews page placeholder).
- **`Meeting`** — booked-meeting record, the funnel's terminal success state alongside `won`/`lost` if later available.

## Guardrails carried forward from `docs/MASTER_SPEC.md`

- **Human-in-the-loop at launch**: AI drafts, a human approves/rejects/corrects before send. Autonomy can later be enabled branch-by-branch — not implemented in Phase 0.
- **No invented facts**: the Setter may only reference facts explicitly marked `approved` in `Offer.approvedCommercialFacts`/`approvedProductFacts`/`approvedClaims` (`src/domain/campaigns/types.ts`). `Offer.forbiddenClaims` (e.g. `therapeutic_claims`, `guaranteed_sales_volume` in the seed offer) must be enforced, not just documented.
- **Idempotent reply ingestion** (lesson from `docs/REFERENCE_AUDIT.md`): reply webhooks must be safe to receive more than once without duplicating conversations/events — a Phase 4 implementation requirement, not yet built.

## Implemented in Phase 4 (`src/services/setter/`, `src/infrastructure/providers/llm/`)

- **`pre-router.ts`** — deterministic, regex-based detection of unsubscribe/do-not-contact (both force
  `suppress: true`), hard negative, out-of-office, bounce/system message, meeting-already-booked,
  wrong-person/forward request, contact-details-supplied and automated-spam cases. Runs before any LLM
  call; the setter orchestrator applies a `suppress: true` result unconditionally.
- **`context-builder.ts`** — assembles a whitelisted `SetterPromptContext` (approved offer facts/claims/
  FAQ/objection guidance, account, contact, capped recent messages and feedback notes) — never a raw DB
  dump.
- **`setter-output-schema.ts`** — Zod schema for the LLM's structured output contract (language, branch,
  intent_summary, confidence, draft, needs_human, reason_for_human, detected_facts_requested, risk_flags,
  suggested_next_action).
- **`classify-and-draft.ts`** — calls the `LLMProvider`, validates with Zod, retries once with a repair
  flag on failure, otherwise falls back to a `HUMAN_REQUIRED` draft; applies guardrails to any valid
  output.
- **`guardrails.ts`** — independently re-checks the LLM's draft against `Offer.forbiddenClaims` (medical/
  therapeutic, certification, legal/regulatory, pharmacy-performance claims) and against approved
  commercial/product fact keys (pricing, margin, minimum order, shipping, stock, exclusivity, historical
  sales, distribution terms); also force-escalates non-approved commercial-negotiation asks (special
  price, discount, exclusivity, territory, volume agreement) to a human.
- **`reply-ingestion.ts`** — idempotent reply normalization (dedup by `providerMessageId`) into
  `Conversation`/`ConversationMessage`, reusing Phase 3's `verifyWebhookSignature`.
- **`review-service.ts`** — applies the six review actions (approve, edit & send, reject, no reply
  needed, escalate, suppress), always recording a `SetterFeedback` row.
- **`feedback-analytics.ts`** — branch accuracy, approval/edit/rejection rate, positive-reply→meeting
  rate, average edits, confidence calibration, and a per-branch performance table.
- **`autonomy-policy.ts`** — `canAutoSend()` policy evaluator (branch allowlist, minimum confidence, no
  risk flags, contact-type constraints, campaign toggle) is built and tested but never invoked from any
  send path; `AUTO_SEND_ENABLED` is a hardcoded `false` constant (mirrors ADR-012's structural-safety
  pattern from the Phase 3 dry-run orchestrator).
- **`warm-followup-service.ts`** — a queue separate from Phase 3's cold-sequence service for positive/
  interested leads that haven't booked; pauses immediately on reply, meeting, unsubscribe, or human
  ownership.
- **`setter-orchestrator.ts`** — composes all of the above for one incoming reply.
- **`infrastructure/providers/llm/mock-provider.ts`** (`MockLLMProvider`) — deterministic keyword
  classifier + template drafting; no real LLM API is called.

## Not yet implemented (Phase 5)

- The Reviews three-column inbox is now real (reads dev-seed data, review actions are demo-only — no persistence yet since there is no DB).
- Meeting-booking calendar integration (`CalendarProvider`, not yet allocated an infrastructure folder).
- Wiring the setter orchestrator to a real reply webhook route / real LLM provider (Phase 4 ships mock-only, per standing project safety decision).

See `docs/PHASE_4_REPORT.md` for the full Phase 4 implementation report.

