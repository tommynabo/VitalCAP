# Architecture — Vitalcap Outreach OS

## 1. Stack (Phase 0)

- **Next.js 16** (App Router, Turbopack build), React 19, TypeScript 6 strict mode.
- **Tailwind CSS 4** (CSS-native `@theme` tokens in `src/app/globals.css`, no `tailwind.config.ts`).
- **Vitest 4** for unit tests, colocated as `*.test.ts` next to the module under test.
- **ESLint 9** flat config, consuming `eslint-config-next`'s flat array directly (no `FlatCompat`/legacy shareable-config bridging — that path breaks under this Next/ESLint combination, see "Known issues" below).
- **Zod 4** for runtime/env validation.
- `clsx` + `tailwind-merge` → `cn()` helper; `class-variance-authority` for variant-based UI primitives (shadcn/ui convention) — no shadcn CLI dependency, primitives are hand-written to stay dependency-light.
- No Supabase project wired yet (Phase 1). No provider credentials configured (Phase 2/3). No git remote created.

## 2. Folder architecture (Appendix A)

```
src/
  app/                  # Next.js routes only — no business logic
    (dashboard)/         # route group: sidebar/topbar shell + all product pages
    api/health/          # /health endpoint
  components/
    ui/                  # framework-agnostic primitives (Card, Badge, Progress)
    layout/              # Sidebar, TopBar, AppShell, nav config
    dashboard/           # dashboard-specific presentational components
    shared/               # cross-page shared components (PhasePlaceholder)
  domain/                 # PURE TypeScript types. Zero framework/infra imports.
    accounts/ contacts/ campaigns/ discovery/ autopilot/ outreach/ conversations/ compliance/ providers/
  services/               # Phase-owned business logic
    deduplication/ enrichment/ verification/ routing/ setter/ discovery/ autopilot/   # discovery/ + autopilot/ added Phase 2
  infrastructure/         # Phase-owned adapters
    supabase/ providers/{maps,serp,email-verification,instantly,sms,llm}/ jobs/   # maps/serp/email-verification mocks + jobs implemented Phase 2
  lib/
    config/               # env validation
    utils/                # cn() etc.
    autopilot/            # pure target math (Phase 0), rebalancing logic is Phase 2
    seed/                 # dev seed mode
    normalization/ geography/ security/ validation/   # README stubs, Phase 1+
```

**Rule enforced now and going forward**: `domain/*` never imports from `services/*`, `infrastructure/*`, or any Next.js/React module. `services/*` implement business logic against `domain/*` types. `infrastructure/*` implements provider/DB adapters behind interfaces declared in `domain/*` or `services/*`. `app/*` only composes components and calls services — no domain logic in route handlers or page components.

## 3. Domain type modules (Phase 0 deliverable)

Each module is pure vocabulary for a later phase's logic — no behavior, only shapes and state-machine enums, so later phases have a stable contract to build against:

- `domain/accounts/types.ts` — `Account`, `AccountSource`, full `AccountStatus` state machine (Appendix B).
- `domain/contacts/types.ts` — `Contact`, `ContactPoint`, `ChannelEligibilityStatus`, verification/eligibility state machines.
- `domain/campaigns/types.ts` — `Offer` (all commercial facts live here, never in code), `Campaign`, `CampaignMembership`.
- `domain/discovery/types.ts` — job/queue models + the shared `DiscoveryEngine` interface all 5 engines implement in Phase 2.
- `domain/autopilot/types.ts` — `EngineTargetState`, `GlobalAutopilotState`, `RebalanceDecision` vocabulary for the Phase 2 Target Engine.
- `domain/outreach/types.ts` — delivery infrastructure types, full `OutreachEventState` machine, `DeliveryMode` (`dry_run` default).
- `domain/conversations/types.ts` — AI Setter branch catalog, conversation state machine, review/feedback types.
- `domain/compliance/types.ts` — `ComplianceGate` contract used by every delivery path.

## 4. Dev seed mode (Phase 0 deliverable)

`src/lib/seed/dev-seed.ts` provides deterministic, in-memory, synthetic Spanish data (1 offer, 5 disabled campaign templates — one per engine, 5 account bundles including a two-source-one-account dedup example and a two-decision-maker example, 5 engine target states matching the §0.4 worked example, 3 rebalance log entries). No database, no external call. UI pages import from here directly in Phase 0; Phase 1 replaces the seed module with a Supabase-backed repository implementing the same domain types, so page-level code should not need to change shape when that happens.

## 5. UI shell

`AppShell` (`components/layout/app-shell.tsx`) = fixed `Sidebar` (12 nav items per §0.11) + `TopBar` (page title derived from route, search affordance, notifications, avatar) + scrollable content area. All 12 nav destinations route to a real page; pages owned by a later phase render a `PhasePlaceholder` naming the exact prompt that implements them, so no dead links exist. Dashboard, Campaigns, Accounts and Contacts render real seed data now since their Phase 0 deliverables (seed mode, shell) are already in scope.

## 6. Known issues / decisions

- **ESLint flat config**: `eslint-config-next@16` now ships a ready flat config array. Using `@eslint/eslintrc`'s `FlatCompat` to extend `"next/core-web-vitals"`/`"next/typescript"` string names (the pre-flat-config pattern) throws `TypeError: Converting circular structure to JSON` from `@eslint/eslintrc`'s config validator against this Next version's plugin objects. Fix: `import nextConfig from "eslint-config-next"` and spread the array directly in `eslint.config.mjs`. Do not reintroduce `FlatCompat` for this project.
- **Next 16 `next.config.ts`**: the `eslint.ignoreDuringBuilds` option no longer exists on `NextConfig`'s type (lint is a separate, non-Next-owned step now: run `npm run lint` explicitly).
- No git remote is created in Phase 0 per ADR-005; only a local `git init` + first commit.

## 7. Phase 2 additions (Discovery Engines + Autopilot Target Engine)

- **`domain/providers/types.ts`**: pure provider contracts (`MapsDiscoveryProvider`, `SerpDiscoveryProvider`, `EmailVerificationProvider`, `WebsiteFetcher`, `ProviderUsageStats`). Services depend only on these interfaces; concrete adapters live in `infrastructure/providers/*` and are never imported directly by a service — even service unit tests construct inline fake implementations of these interfaces rather than importing the infra mocks, to keep the dependency direction correct.
- **`services/discovery/`**: `spain-search-catalog.ts` + `geography-planner.ts` (seed generation/selection), `business-type.ts`, `provider-health.ts`, `candidate-processor.ts` (the single shared pipeline every engine's raw candidates flow through — Spain eligibility → dedup → business-type → contact-point discovery/verification → ready evaluation), the five `DiscoveryEngine` implementations (`maps-fast-engine.ts`, `maps-deep-engine.ts`, `google-serp-engine.ts`, `linkedin-owner-engine.ts`, `hybrid-fill-engine.ts` + `hybrid-fill-decision.ts`), and `discovery-router.ts`.
- **`services/enrichment/`**: `email-extraction.ts`, `website-crawler.ts`.
- **`services/verification/email-verification-cache.ts`**: TTL cache in front of batch verification calls.
- **`services/autopilot/`**: `pacing-service.ts`, `quota-rebalancer.ts`, `queue-health-service.ts`, `autopilot-scheduler.ts` (the orchestrator composing all three plus Hybrid Fill decisions into one tick), and `simulate-autopilot-day.ts` (the §2.15 integration harness).
- **`services/compliance/`**: `suppression-service.ts` (workspace-wide, idempotent suppression checks/adds) and `compliance-gate.ts` (`SuppressionAwareComplianceGate`, the single implementation of `domain/compliance`'s `ComplianceGate` — suppression always wins, channel eligibility is per-channel and never transitive).
- **`services/outreach/`**: `channel-router.ts` (`routeAccountToEndpoint` — endpoint ranking via Phase 1's `priorityScore`, one-active-path concurrency, account cooldown), `sender-pool-service.ts` (mailbox/domain capacity + health), `channel-mix-planner.ts` (desired vs. actual channel mix, shortfall reporting), `sequence-service.ts` (cold/warm follow-up gating, reply-pause, bounce-cancel), `message-renderer.ts` (whitelisted `Offer`-backed template substitution), `outreach-event-ingestion.ts` (idempotent, signature-verified webhook ingestion), and `outreach-orchestrator.ts` (`runOutreachDryRunCycle`, the composed dry-run pass — see ADR-012 for why it structurally cannot call a real delivery provider).
- **`infrastructure/jobs/job-queue.ts`**: pure atomic-claim/backoff/dead-letter primitives over `JobRecord[]` — the real DB-backed claim (e.g. `SELECT ... FOR UPDATE SKIP LOCKED`) is a Phase-1-schema/Phase-3-wiring concern; this module defines the exact semantics that implementation must match.
- **`infrastructure/providers/{maps,serp,email-verification}/mock-provider.ts`** + `deterministic-fixtures.ts`: deterministic, seeded mock adapters — no real external API calls anywhere in Phase 2, per the standing mock-only decision (see ADR log).
- **`infrastructure/providers/{instantly,sms}/mock-provider.ts`**: Phase 3's mock `EmailDeliveryProvider`/`SmsDeliveryProvider`, same deterministic-fixture pattern, not wired into the dry-run orchestrator (ADR-012).
- **`lib/security/safe-fetch.ts`**: SSRF-safe fetch used by the website crawler — manual bounded redirect loop, hostname/IP blocklist re-checked per hop, injectable resolver/fetch for testability.

See [`docs/DECISIONS.md`](./DECISIONS.md) for the full ADR log.

## 8. Phase 4 additions (AI Setter, reply classification, human review, learning loop)

- **`domain/providers/types.ts`** (extended): `SetterPromptContext` (whitelisted context passed to any
  `LLMProvider`), `SetterClassificationOutput` (loose `branch: string`, narrowed by a service-layer Zod
  schema), `LLMProvider` interface (`classifyAndDraft`).
- **`services/setter/` composition, applied in this order by `setter-orchestrator.ts`**:
  1. `pre-router.ts` — deterministic regex-based branch/suppression detection, runs before any LLM call.
  2. Suppression check (reused from Phase 3's `services/compliance/suppression-service.ts`) for
     pre-existing suppression entries — also blocks the LLM path.
  3. `context-builder.ts` — builds the whitelisted `SetterPromptContext`.
  4. `classify-and-draft.ts` — calls the `LLMProvider`, Zod-validates via `setter-output-schema.ts`,
     retries once with a repair flag, falls back to a `HUMAN_REQUIRED` draft on double failure.
  5. `guardrails.ts` — independently re-checks the (now Zod-valid) draft against forbidden claims and
     non-approved commercial negotiation, forcing `needsHuman: true` when triggered.
- **`reply-ingestion.ts`**: idempotent reply webhook ingestion (dedup by `providerMessageId`), reuses
  Phase 3's `verifyWebhookSignature` rather than duplicating HMAC logic.
- **`review-service.ts`**: the only function that can move a conversation to `"sent"` — applies one of six
  human review decisions, always records a `SetterFeedback` row.
- **`feedback-analytics.ts`**: pure aggregation for the learning loop (branch accuracy, approval/edit/
  rejection rate, confidence calibration, per-branch performance).
- **`autonomy-policy.ts`**: `canAutoSend()` policy evaluator — built and tested, but not imported by
  `review-service.ts` or `setter-orchestrator.ts`; `AUTO_SEND_ENABLED` is a hardcoded `false` constant
  (see ADR-017, mirrors ADR-012's structural-safety pattern).
- **`warm-followup-service.ts`**: a queue distinct from Phase 3's cold-sequence service, for
  interested-but-not-yet-booked leads (see ADR-018).
- **`infrastructure/providers/llm/mock-provider.ts`** (`MockLLMProvider`): deterministic keyword
  classifier + template drafting, same `deterministic-fixtures.ts` pattern as Phase 2/3's mocks — no real
  LLM API is called anywhere in Phase 4.
- **`app/(dashboard)/reviews/page.tsx`**: three-column human review inbox (conversation list / thread /
  AI analysis + draft + review actions), reading dev-seed data.
- **`app/(dashboard)/setter/page.tsx`**: AI Setter dashboard (KPI row + branch performance table), backed
  by `feedback-analytics.ts`.

See [`docs/DECISIONS.md`](./DECISIONS.md) for the full ADR log (ADR-015 through ADR-018 cover this phase).

## 9. Phase 5 additions (Full frontend / UX / visual system)

UI-only phase — no `domain/` or `services/` files changed.

- **`components/ui/`** grew to a full primitive set: `button.tsx`, `select.tsx`, `input.tsx`, `tabs.tsx`
  (render-prop, controlled/uncontrolled), `table.tsx`, `skeleton.tsx` (+ `PageSkeleton`), `empty-state.tsx`,
  `error-state.tsx` (expandable "technical details" instead of a raw dump), `sheet.tsx` (portal-based
  right-side drawer for account/campaign detail), `charts.tsx` (dependency-free `MiniBarChart`/
  `FunnelChart`/`MixBar` — no charting library was added).
- **`components/layout/sidebar-context.tsx`**: `SidebarProvider`/`useSidebar()` — collapsed state
  (persisted to `localStorage`) and mobile drawer open state, consumed by the rewritten `Sidebar`/`TopBar`.
- **`components/layout/nav-badges.ts`**: `getNavBadgeCounts()` computes nav badge counts from seed data,
  kept separate from the pure `nav-config.ts` by design.
- **`components/dashboard/activity-rail.tsx`**: consolidated "needs your attention" feed (provider alerts,
  rebalance activity, pending reviews, mailbox issues, verification quota warnings) replacing the narrower
  Phase-0-era rebalance-only rail on the Dashboard.
- **`lib/seed/dev-seed.ts`** (additive only): `seedWeeklyTrend`, `seedProviderRows`,
  `seedEmailVerificationUsage`, `seedSearchSeeds`, `seedQueueHealth`, `seedDeadLetterSamples`.
- **Every page under `app/(dashboard)/*`** rewritten or extended to a real screen: Dashboard (activity
  rail + trend/mix/funnel/top-campaign sections), Campaigns (richer table + `Sheet` detail with 8 tabs +
  guided creation form), Autopilot (flagship: pause/resume/emergency-stop banner, target allocation bars,
  queue health, provider health/dead-letter), Discovery (search-seed coverage table, built from placeholder),
  Accounts (`Sheet` detail drawer), Contacts (generic-vs-named visual distinction in one table), Outreach
  (tab-based queue: Scheduled/Sent/Replies/Failed/Suppressed, mix chart, sender pool health), Reviews
  (keyboard shortcuts A/E/R/S/N with same-key-twice confirmation), Analytics (full funnel + breakdowns,
  built from placeholder, deliberately no single "best engine" score), Infrastructure (placeholder wrapper
  removed), Settings (real workspace/offer/user page, built from placeholder).
- **`PhasePlaceholder` retirement**: no page in the main navigation uses the Phase-0-era placeholder
  wrapper anymore (§5.16 "no debug screens in main navigation"); the component file itself is kept but
  unused.

