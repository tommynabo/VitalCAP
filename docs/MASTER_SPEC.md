# Master Spec — Vitalcap Outreach OS

Source of truth: [`VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md`](../VITALCAP_OUTREACH_OS_MASTER_PROMPTS.md) (Prompts 0–6 + Appendices A–D). This document is a distilled index of that spec for day-to-day engineering reference. If anything here conflicts with the master prompts file, **the master prompts file wins**.

## 1. Business objective

Vitalcap Outreach OS identifies relevant physical retail businesses in Spain, discovers their best available business contacts, qualifies them, routes them into the correct outreach channel, manages responses with an AI Setter, and drives qualified prospects to a scheduled call with the sales director.

- **Country**: Spain only.
- **Primary ICP**: independent pharmacies. Acceptable: parapharmacies, herbal shops, sports nutrition stores, supplement stores, other physical retailers reasonably capable of selling supplements. The ICP is intentionally broad at launch — data first, aggressive exclusion later.
- **Ideal decision maker**: owner, titular pharmacist, owner-manager, manager, purchasing manager or equivalent. Generic account email is acceptable as a fallback and may still reach the owner.
- **Sourcing constraint**: public business/professional info and publicly discoverable named contacts only. No Apollo/data-broker as primary discovery source. Third-party verification providers are fine for validating an already-discovered email.
- **Final CTA**: book a call via a configurable scheduling link with the sales director.
- **Commercial facts** (e.g. 51% pharmacy share) are configurable `Offer` data, never hard-coded in source or prompts.
- **Daily ambition**: ~250 new outreach-ready prospects/day, indicative channel mix ~125 email + 125 SMS (a target, not a rule that can override compliance/deliverability/contact-availability).
- **AI Setter**: human-in-the-loop at launch (AI drafts, human approves/rejects/corrects). Autonomy can later be enabled branch by branch.

## 2. Product philosophy

The product is **Autopilot**, not manual lead generation. The workflow is:

> configure campaign → enable autopilot → system continuously discovers, processes, deduplicates, verifies, queues, routes and reports progress toward daily targets.

Not: "enter query → click search → wait → export CSV". A small developer/debug action may exist, but the product must not depend on a manual generator.

## 3. Five discovery engines (Phase 2)

All engines implement one shared `DiscoveryEngine` contract (see [`src/domain/discovery/types.ts`](../src/domain/discovery/types.ts)) and normalize into the same `Account`/`Contact` domain model.

| Engine | Purpose |
|---|---|
| `maps_fast` | High-volume, low-cost establishment discovery (Maps/Places → Spain filter → normalize → dedup → light fit → website → light email extraction → validation → priority → outreach-ready). No expensive owner enrichment by default. |
| `maps_deep` | Lower-volume, higher-quality account + decision-maker enrichment (adds website crawl, contact/about/legal-notice/team extraction, public owner search, public LinkedIn URL discovery). |
| `google_serp` | Discovery via Google Search-style SERP providers with query expansion across category synonyms, Spanish geography, supplement-purchase terminology. |
| `linkedin_owner` | Decision-maker-first discovery via public web/SERP search for owner/titular/manager/purchasing-manager profiles → company → domain → account → contacts. No authenticated LinkedIn scraping requirement. |
| `hybrid_fill` | Target-aware deficit filler: broadens geography/subcategories, rotates queries, reprocesses incomplete accounts, deepens enrichment — always choosing the cheapest healthy path, never knowingly lowering below the configured minimum quality bar. |

## 4. Target model (Phase 2 — Autopilot Target Engine)

- Global daily outreach-ready target: **250**.
- Five engine **soft** targets: 50 each (soft, not hard — never force low-quality/duplicate leads to hit 50 on a starved engine).
- Deficits rebalance across healthy engines. Worked example baked into tests ([`src/lib/autopilot/targets.test.ts`](../src/lib/autopilot/targets.test.ts)):

  ```
  Maps Fast        60
  Maps Deep        50
  Google SERP      63
  LinkedIn Owner   27
  Hybrid Fill      50
  ------------------
  Total            250
  ```
- Funnel stages tracked distinctly, never conflated: raw discovered → unique accounts → contacts found → verified contacts → outreach-ready → sent → delivered → replied → positive → meeting booked → won/lost. Raw discovery is never counted as success.
- Maintain a ready buffer of ~3–7 days of qualified inventory (250/day ⇒ 750–1750 outreach-ready prospects). Sending must not depend on live discovery being available at send time.

## 5. Architecture principle — producers vs. processors

No single synchronous `search → enrich → validate → send` function. Queues/state machines only, with these conceptual layers: discovery producers → raw candidate queues → normalization/dedup workers → enrichment workers → verification workers → qualification/routing → outreach-ready queue → delivery workers → reply ingestion → AI Setter → human review → sales handoff.

## 6. Compliance / channel eligibility (cross-cutting, all phases)

Discovery ≠ permission to send. See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and `src/domain/compliance/types.ts` for the `ComplianceGate` contract and the full `ChannelEligibilityStatus` state set. The system must never bypass global suppression, explicit opt-out, channel block, invalid email, provider bounce suppression, SMS opt-out, or account-level pause.

## 7. Phase map

See [`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the full Prompt 0–6 phase-by-phase plan, acceptance criteria and non-negotiables. Current phase: **Phase 0 — complete** (this repository state). Prompt 1 is not started and will not begin without explicit instruction.
