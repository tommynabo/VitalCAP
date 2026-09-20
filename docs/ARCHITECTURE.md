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
    accounts/ contacts/ campaigns/ discovery/ autopilot/ outreach/ conversations/ compliance/
  services/               # Phase-owned business logic (README stubs only in Phase 0)
    deduplication/ enrichment/ verification/ routing/ setter/
  infrastructure/         # Phase-owned adapters (README stubs only in Phase 0)
    supabase/ providers/{maps,serp,email-verification,instantly,sms,llm}/ jobs/
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

See [`docs/DECISIONS.md`](./DECISIONS.md) for the full ADR log.
