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

All primitives compose via the shared `cn()` helper (`src/lib/utils/cn.ts`, `clsx` + `tailwind-merge`) so callers can safely override classes without specificity fights.

## Layout (`src/components/layout/`)

- `nav-config.ts` — single source of truth for the 12 sidebar items (§0.11): Dashboard, Campaigns, Autopilot, Discovery, Accounts, Contacts, Outreach, AI Setter, Reviews, Analytics, Infrastructure, Settings — each with a `lucide-react` icon.
- `Sidebar` — fixed, active-state highlighted via `usePathname`, `aria-current="page"` on the active link.
- `TopBar` — derives the page title from the current route via the same nav config, plus a search affordance, notification button and avatar (all presentational in Phase 0 — no real search/notifications yet).
- `AppShell` — composes `Sidebar` + `TopBar` + scrollable content area, used by the `(dashboard)` route group layout so every page automatically gets the shell.

## Accessibility (§0.10)

- Keyboard navigation via native `<a>`/`<button>` elements (Next `Link`), no custom click-only divs for interactive elements.
- Visible focus states via a global `:focus-visible` outline rule in `globals.css` (uses `--color-primary`, 2px, 2px offset).
- Semantic HTML: `<aside>`/`<nav aria-label="Main navigation">`/`<header>`/`<main>`/`<table>` used for their intended purpose.
- No status conveyed by color alone: every `Badge` carries text (e.g. "degraded", "draft"), not just a color.

## Pages shipped in Phase 0

- `/` Dashboard — real seed data: KPI row, autopilot progress card, rebalance activity rail, 5 engine cards.
- `/campaigns` — real seed data: 5 disabled campaign templates in a table.
- `/autopilot` — real seed data: same 5 engine cards as a `PhasePlaceholder`-wrapped preview, explicitly labeled as a Phase 2/5 flagship screen.
- `/accounts`, `/contacts` — real seed data tables.
- `/discovery`, `/outreach`, `/setter`, `/reviews`, `/analytics`, `/infrastructure`, `/settings` — `PhasePlaceholder` cards naming the exact prompt/phase that implements each screen, so every nav destination is navigable and never a dead link or blank page.
