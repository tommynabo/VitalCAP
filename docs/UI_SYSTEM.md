# UI System — Vitalcap Outreach OS

## Limitation acknowledged up front

No `references/` folder or reference screenshot images exist anywhere in this workspace (confirmed via directory listing before implementation). The visual direction below was built directly from the written spec in Prompt 0 §0.10/§0.11 only — no image-based reference was available to inspect. If reference images become available later, this document and the `globals.css` tokens should be revisited against them.

## Visual language (from §0.10)

Warm, restrained, premium B2B — explicitly **not** a copy of FlowNex/ApexEngine's look, and explicitly not: purple SaaS gradients, neon, dark cyber dashboards, marketing hero blocks inside the app, excessive glassmorphism, or oversized cards.

- Warm ivory app background, clean white cards, restrained orange accent, near-black typography, subtle warm-beige borders, minimal soft shadows, generous whitespace, compact-but-premium density.
- Fixed left sidebar (desktop) + top bar with page context/search/compact actions.
- Rounded cards 12–16px; status pills and numeric badges; clean tables.
- Orange = primary actions, active nav state, important progress. Green = success only. Red = errors/risk only. Muted amber = warnings only. Color is never the only signal (icons/text accompany every status).

## Design tokens (`src/app/globals.css`, Tailwind v4 `@theme` block)

| Token | Value | Usage |
|---|---|---|
| `--color-background` | `#F7F4EF` | App shell background |
| `--color-surface` | `#FFFFFF` | Cards, sidebar, top bar |
| `--color-surface-muted` | `#FBF9F6` | Muted panels, table headers, hover states |
| `--color-border` | `#E8E3DC` | All hairline borders |
| `--color-text` | `#171717` | Primary text |
| `--color-text-muted` | `#6F6B66` | Secondary text |
| `--color-primary` | `#F26A21` | Primary actions, active nav, key progress |
| `--color-primary-hover` | `#DD5B17` | Hover state of the above |
| `--color-primary-soft` | `#FFF1E7` | Active nav background, primary badges |
| `--color-success` / `--color-success-soft` | muted green pair | Success only |
| `--color-warning` / `--color-warning-soft` | muted amber pair | Warnings only |
| `--color-danger` / `--color-danger-soft` | restrained red pair | Errors/risk only |
| `--radius-card` | `16px` | Card corners |
| `--radius-control` | `10px` | Buttons, inputs, nav items |
| `--font-sans` | Inter (via `next/font/google`) | All UI text |

## Component primitives (`src/components/ui/`)

- `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` — shadcn-style composable card.
- `Badge` — `class-variance-authority`-driven variants: `neutral` (default), `primary`, `success`, `warning`, `danger`.
- `Progress` — accessible (`role="progressbar"`, `aria-valuenow/min/max`) linear progress bar.
- `Button` — variants `primary|secondary|ghost|danger` × sizes `sm|md|icon`.
- `Select` / `Input` — design-token-styled native form controls.
- `Tabs` — render-prop tab list (`role="tablist"`/`role="tab"`), controlled or uncontrolled.
- `Table` / `TableHead` / `TableBody` / `TableRow` / `TableHeadCell` / `TableCell` — thin styled wrappers around native table elements, auto-scroll on overflow.
- `Skeleton` / `PageSkeleton` — loading placeholders (`aria-busy="true"`).
- `EmptyState` — icon + title + description + optional action for zero-data screens.
- `ErrorState` — friendly error card with an opt-in "Technical details" disclosure instead of a raw stack trace (§5.14).
- `Sheet` — right-side drawer rendered via `createPortal`, closes on Escape/backdrop click, used for account/campaign detail views.
- `charts.tsx` — dependency-free `MiniBarChart`, `FunnelChart`, `MixBar` (div/SVG based; no charting library was added, per avoiding over-engineering).

All primitives compose via the shared `cn()` helper (`src/lib/utils/cn.ts`, `clsx` + `tailwind-merge`) so callers can safely override classes without specificity fights.

## Layout (`src/components/layout/`)

- `nav-config.ts` — single source of truth for the 12 sidebar items (§0.11): Dashboard, Campaigns, Autopilot, Discovery, Accounts, Contacts, Outreach, AI Setter, Reviews, Analytics, Infrastructure, Settings — each with a `lucide-react` icon. Kept free of any seed-data dependency by design.
- `nav-badges.ts` — `getNavBadgeCounts()` computes numeric nav badges (pending reviews, degraded engines/domains/mailboxes) from seed data, kept separate from `nav-config.ts` so the nav skeleton stays pure.
- `sidebar-context.tsx` — `SidebarProvider`/`useSidebar()`: collapsed state (persisted to `localStorage`) and mobile drawer open state.
- `Sidebar` — desktop collapsible icon rail (72px collapsed / 240px expanded) plus an off-canvas mobile drawer (`md:hidden`), active-state highlighted via `usePathname`, `aria-current="page"` on the active link, badge pills next to nav labels.
- `TopBar` — page title derived from the current route, a mobile hamburger button to open the sidebar drawer, search affordance, notification button and avatar (presentational — no real search/notifications wired yet).
- `AppShell` — wraps the tree in `SidebarProvider` and composes `Sidebar` + `TopBar` + scrollable content area, used by the `(dashboard)` route group layout so every page automatically gets the shell.

## Accessibility (§0.10)

- Keyboard navigation via native `<a>`/`<button>` elements (Next `Link`), no custom click-only divs for interactive elements.
- Visible focus states via a global `:focus-visible` outline rule in `globals.css` (uses `--color-primary`, 2px, 2px offset).
- Semantic HTML: `<aside>`/`<nav aria-label="Main navigation">`/`<header>`/`<main>`/`<table>` used for their intended purpose.
- No status conveyed by color alone: every `Badge` carries text (e.g. "degraded", "draft"), not just a color.

## Pages (final state as of Phase 5)

Every nav destination is now a full page — no `PhasePlaceholder`-wrapped screens remain in the main navigation (§5.16).

- `/` Dashboard — KPI row, autopilot progress card, "needs your attention" activity rail (provider alerts, rebalance activity, pending reviews, mailbox issues, verification quota), 5 engine cards, weekly reply/meeting trend, channel mix, discovery-to-meeting funnel, top campaign performance.
- `/campaigns` — table with reply rate/meetings/health columns, row click opens a `Sheet` detail with 8 tabs (Overview/Engine config/Target & schedule/ICP/Outreach/Setter/Activity/Settings), guided "New campaign" creation form with an Advanced JSON accordion (no raw-JSON-first editor).
- `/autopilot` — flagship screen: pause/resume/emergency-stop banner, KPI row, target allocation progress bars per engine, engine cards, rebalance activity, queue health, provider health + dead-letter samples.
- `/discovery` — search-seed coverage table (engine/query/geography/raw/unique/ready/yield/exhaustion), KPI row, near-exhaustion warning banner.
- `/accounts` — table + row click opens a `Sheet` detail (identity, source evidence, contact graph, contact points, fit/status).
- `/contacts` — named contacts (person badge) and generic account-level endpoints (muted, mailbox badge) visually distinguished in one table.
- `/outreach` — KPI row, bounce/opt-out alert banner, channel mix chart, sender pool health card, tab-based queue (Scheduled/Sent/Replies/Failed/Suppressed) with channel/campaign filters.
- `/setter`, `/reviews` — AI Setter dashboard and reviews inbox (Phase 4); reviews now also supports keyboard shortcuts (A/E/R/S approve/edit/reject/suppress, N next) with a same-key-twice confirmation so an accidental keypress never sends anything.
- `/analytics` — discovery-to-meeting funnel plus breakdowns by engine, campaign, business type, province, channel, generic-vs-named contact and owner-vs-role, and comparative rate/yield metrics — deliberately no single "best engine" score.
- `/infrastructure` — sending domains, mailboxes, provider status (incl. email verification quota) — no secret values ever displayed after save.
- `/settings` — workspace info, offer/commercial-fact display (name, CTA, forbidden claims), user profile stub.
