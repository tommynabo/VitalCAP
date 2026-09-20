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

## Not yet implemented (Phase 4)

- Reply ingestion endpoint/webhook handler.
- Deterministic pre-router (cheap rule-based branch shortcuts before invoking an LLM).
- `LLMProvider`-backed classification and draft generation (`src/infrastructure/providers/llm/`, currently a README stub).
- The Reviews three-column inbox UI (conversation list, thread, AI analysis + draft controls) — Phase 0 only ships a `PhasePlaceholder` at `/reviews`.
- `SetterAgentService` / `SetterFollowupService` (naming inspired conceptually by FlowNex, not copied — see `docs/REFERENCE_AUDIT.md`).
- Meeting-booking calendar integration (`CalendarProvider`, not yet allocated an infrastructure folder).
