# VITALCAP OUTREACH OS — MASTER BUILD PROMPTS

> Documento maestro para construir desde cero un sistema B2B de prospección, enriquecimiento, autopiloto, outreach multicanal y AI Setter orientado inicialmente a Vitalcap y al mercado español.
>
> **Modo de uso recomendado:** no pegar todo en una sola ejecución. Ejecutar los prompts por fases en el mismo repositorio. El Prompt 0 crea la fuente de verdad del proyecto; los Prompts 1–6 implementan cada subsistema. Cada fase debe terminar estable, testeada y documentada antes de seguir.

---

# PROMPT 0 — PRODUCT SOURCE OF TRUTH + REPO AUDIT + PROJECT BOOTSTRAP

You are a senior product engineer, software architect, data engineer and AI systems engineer. You are going to build a new production application from scratch. Do not clone an existing application and change its niche. Do not produce a toy demo. Build a maintainable system with production-grade data modeling, background processing, observability, idempotency, provider abstractions and a polished desktop-first UI.

The working product name is **Vitalcap Outreach OS**.

## 0.1. Business objective

The initial customer/business is Vitalcap, a Spanish supplement brand. The system is intended to identify relevant physical retail businesses in Spain, discover their best available business contacts, qualify them, route them into the correct outreach channel, manage responses with an AI Setter, and ultimately drive qualified prospects to a scheduled call with the sales director.

Initial commercial facts supplied by the business:
- Country: Spain only.
- Main target: independent pharmacies.
- Additional acceptable targets: parapharmacies, herbal shops, sports nutrition stores, supplement stores and other physical retailers reasonably capable of selling supplements.
- Do not over-restrict the ICP in the first version. We need data before aggressively excluding categories.
- Ideal decision maker: owner, titular pharmacist, pharmacy owner-manager, manager, purchasing manager or equivalent.
- A generic pharmacy email can still be valuable and may reach the owner.
- Multiple contacts for the same account are allowed.
- Contact priority should favor the decision maker before the generic establishment contact.
- We want public business addresses, professional addresses and publicly discoverable named work contacts. Do not use Apollo or a data broker as the primary source for discovering the owner. Third-party services may be used for email verification/validation.
- Final CTA: book a call through a configurable scheduling link to speak with the sales director.
- Commercial proposition supplied by the business includes a 51% pharmacy share/commission per sale. This must be treated as a configurable approved commercial fact, not a hard-coded assumption throughout the codebase.
- Do not invent product, medical, regulatory, logistical, pricing or commercial claims. The AI Setter may only use facts explicitly marked as approved in the campaign/offer configuration.
- Daily ambition: approximately 250 new outreach-ready prospects / contact opportunities per day.
- Desired initial channel mix may be approximately 125 email + 125 SMS, but channel allocation is a target, not a rule that can bypass compliance eligibility, sender capacity, deliverability constraints or lack of a valid contact point.
- AI Setter initially operates in human-in-the-loop mode: AI drafts, a human approves / rejects / corrects. Later, autonomy can be enabled branch by branch.

## 0.2. Product philosophy

The primary product is **Autopilot**, not manual lead generation.

Do NOT make the main product workflow:
"enter query -> click search -> wait -> export CSV".

The product workflow must be:
"configure campaign -> enable autopilot -> system continuously discovers, processes, deduplicates, verifies, queues, routes and reports progress toward daily targets".

A small developer/test action may exist for debugging a provider or a campaign configuration, but the product should not depend on a manual generator.

## 0.3. Five initial discovery engines

The system must support multiple discovery engines behind a shared interface.

Initial engine types:

### A. `maps_fast`
Purpose: high-volume, low-cost establishment discovery.

Typical flow:
Google Maps / Places-compatible provider
-> Spain hard filter
-> account normalization
-> global account dedup
-> lightweight category fit
-> website discovery
-> lightweight email extraction
-> email validation
-> contact prioritization
-> outreach-ready

Do not perform expensive owner enrichment unless required by configuration.

### B. `maps_deep`
Purpose: lower-volume, higher-quality account + decision-maker enrichment.

Typical flow:
Maps discovery
-> account normalization
-> entity dedup
-> Spain hard filter
-> website crawl
-> account qualification
-> contact page / about / legal notice / team extraction
-> public web search for owner / titular / manager
-> public LinkedIn URL discovery where available
-> email discovery from public sources
-> verification
-> contact graph
-> contact priority
-> outreach-ready

### C. `google_serp`
Purpose: discover businesses and websites through Google Search-style SERP providers rather than Maps.

Use query expansion across:
- business category synonyms,
- Spanish geographic units,
- purchase/supplement-related terminology,
- result types.

Normalize results into the same Account domain model as every other engine.

### D. `linkedin_owner`
Purpose: decision-maker-first discovery.

Use public web/SERP discovery for profiles and businesses such as:
- titular farmacéutico,
- propietario de farmacia,
- dueño de farmacia,
- gerente de farmacia,
- responsable de compras,
- purchasing manager,
- equivalent Spanish titles.

Do not rely on authenticated LinkedIn scraping as a requirement.
Prefer public search discovery and provider abstractions.
Person -> company -> domain -> account -> contact points.

### E. `hybrid_fill`
Purpose: fill the daily deficit when one or more engines underperform.

It can:
- expand geographic coverage,
- broaden accepted retail subcategories,
- rotate new query templates,
- reprocess incomplete accounts,
- deepen website enrichment,
- run additional Maps or Google discovery,
- harvest decision makers from existing accounts.

It must be target-aware and should choose the cheapest healthy path likely to fill the deficit without knowingly lowering below configured minimum quality.

## 0.4. Target model

Initial desired configuration:

- global daily outreach-ready target: 250
- five engine soft targets: 50 each

Important:
- 50 per engine is a **soft target**.
- 250 global is the primary target.
- If one engine produces only 27 healthy unique prospects, do not force low-quality or duplicate leads just to display 50.
- Rebalance the remaining 23 across engines with healthy inventory.

Example:
Maps Fast 60
Maps Deep 50
Google SERP 63
LinkedIn Owner 27
Hybrid Fill 50
Total 250

The system must distinguish:
- raw discovered
- unique accounts
- contacts found
- verified contacts
- outreach-ready
- sent
- delivered
- replied
- positive
- meeting booked
- won/lost if later available

Never count raw discovery as success.

## 0.5. Architecture principle: Producers and Processors are separate

Do not implement one long synchronous function:
search -> enrich -> validate -> send -> repeat.

Use queues / state machines.

Conceptual layers:
1. Discovery producers
2. Raw candidate queues
3. Normalization + dedup workers
4. Enrichment workers
5. Contact verification workers
6. Qualification / routing
7. Outreach-ready queue
8. Delivery workers
9. Reply ingestion
10. AI Setter
11. Human review
12. Sales handoff

Maintain a ready buffer. Target roughly 3–7 days of qualified inventory when practical:
250/day => 750–1750 outreach-ready prospects.

The sender should not depend on live discovery being available at the exact send moment.

## 0.6. Reference repositories

If accessible, inspect these repositories before implementing:

- `tommynabo/ApexEngine`
- `tommynabo/FlowNex`

Use them as architectural references only.

Important concepts to inspect:

ApexEngine:
- `services/deduplication/DeduplicationService.ts`
- historical anti-duplicate logic
- search/enrichment orchestration
- pre-flight duplicate filtering before expensive processing

FlowNex:
- `services/search/SearchService.ts`
- `services/deduplication/DeduplicationService.ts`
- `services/search/EmailDiscoveryService.ts`
- discovery provider pattern
- `api/cron/autopilot-engine.ts`
- `api/cron/autopilot-processor.ts`
- `api/instantly-add-lead.ts`
- `api/scrape-email.ts`
- `api/webhooks/instantly-reply.ts`
- `services/setter/SetterAgentService.ts`
- `services/setter/SetterFollowupService.ts`
- `api/setter/send-reply.ts`
- `api/cron/setter-followup.ts`
- `supabase/setter_module_schema.sql`
- `SistemaLinkedin`
- `SistemaLinkedinV2`

Important lessons from those repos:
- Pre-flight dedup before spending provider credits is good.
- SearchService as a thin router to provider-specific engines is good.
- Producer/processor queues are good.
- Setter feedback and human review are good.
- Idempotent reply ingestion is mandatory.
- Current FlowNex creator-specific fields and 30-day handle dedup must NOT be copied as the new core data model.
- Do not use one giant `leads` table as the center of the new architecture.
- Some LinkedIn V2 code in FlowNex references shared files that may not exist in the current branch. Treat it as conceptual, not authoritative.
- Avoid hardcoded campaign IDs, prices, Calendly URLs, brand facts and niche-specific setter branches in source code.

Create:
`docs/REFERENCE_AUDIT.md`

It must contain:
- patterns worth reusing conceptually,
- patterns to reject,
- migration lessons,
- the new architecture decision.

## 0.7. Required stack

Use a modern, production-friendly TypeScript stack.

Preferred:
- current stable Next.js with App Router
- TypeScript strict mode
- Tailwind CSS
- shadcn/ui or similarly accessible primitive-based component system
- Supabase Postgres + Auth
- server-side Supabase service client only where privileged access is needed
- Vercel-compatible deployment
- background jobs implemented through a clean abstraction; Vercel Cron is acceptable for the first production version
- Zod for runtime validation
- Recharts or equivalent for dashboard charts
- React Hook Form for complex forms if useful

Do not tie domain logic to framework route handlers. Domain services must be testable independently.

Use current stable package versions already supported by the environment.
Do not blindly upgrade packages just because a newer major version exists.

## 0.8. Provider abstraction

No external provider should be hard-coded into the domain layer.

Define interfaces such as:
- `MapsDiscoveryProvider`
- `SerpDiscoveryProvider`
- `WebsiteFetcher`
- `EmailVerificationProvider`
- `EmailDeliveryProvider`
- `SmsDeliveryProvider`
- `CalendarProvider` if needed
- `LLMProvider`

Provider adapters must live in infrastructure modules.

The app should continue working in a development/demo mode with mock providers and seed data.

If an external provider API is undocumented or unavailable, build the adapter interface and a safe mock/stub. Do not invent endpoints.

Before implementing a real provider integration, consult that provider's official documentation.

## 0.9. Compliance / channel eligibility architecture

Store discovery separately from channel eligibility.

Finding a public email or phone number does not itself equal permission to send via every channel.

Create a configurable eligibility layer such as:
- `unknown`
- `professional_contact`
- `eligible_email`
- `eligible_sms`
- `eligible_call`
- `consented_email`
- `consented_sms`
- `prior_relationship`
- `opted_out`
- `blocked`

Do not hard-code legal conclusions in business logic.
Build a `ComplianceGate` / `ChannelEligibilityService` that applies workspace configuration, suppression status and campaign rules before delivery.

The system must never bypass:
- global suppression,
- explicit opt-out,
- channel block,
- invalid email,
- provider bounce suppression,
- SMS opt-out,
- account-level pause.

## 0.10. UI visual direction

The frontend must NOT visually resemble the existing FlowNex/ApexEngine repositories.

Use the attached reference images as visual inspiration only, not as layouts to copy pixel-for-pixel.

Desired visual language:
- warm off-white / ivory app background
- clean white cards
- restrained orange accent
- black / charcoal typography
- subtle beige/gray borders
- minimal, soft shadows
- generous whitespace
- compact but premium B2B dashboard feel
- fixed left sidebar on desktop
- top bar with page context, search and compact actions
- rounded cards around 12–16px
- status pills and numeric badges
- clean tables
- orange used for primary actions, active nav states and important progress
- green only for success
- red only for errors/risk
- muted yellow for warnings
- no purple SaaS gradients
- no neon
- no dark cyber dashboard
- no huge hero marketing blocks inside the app
- no excessive glassmorphism
- no oversized cards wasting vertical space

Suggested tokens:
- app background: warm ivory around `#F7F4EF`
- card: `#FFFFFF`
- primary orange: around `#F26A21`
- primary hover: slightly darker orange
- text: near `#171717`
- secondary text: around `#6B6B6B`
- border: warm light gray/beige around `#E8E3DC`
- success: muted green
- warning: muted amber
- danger: restrained red

Use a neutral modern sans font such as Geist or Inter.

Accessibility:
- keyboard navigation
- visible focus states
- semantic HTML
- meaningful labels
- good contrast
- no status indicated by color alone

## 0.11. Product information architecture

Desktop sidebar:

- Dashboard
- Campaigns
- Autopilot
- Discovery
- Accounts
- Contacts
- Outreach
- AI Setter
- Reviews
- Analytics
- Infrastructure
- Settings

Recommended supporting top-level UI states:
- global search
- notifications/activity
- workspace selector if multi-workspace support is retained
- user menu

Do not build unnecessary marketplace/ecommerce concepts from the reference UI screenshots. Use their visual language only.

## 0.12. Deliverables for Prompt 0

Before implementing the full product:

1. Create project skeleton.
2. Create:
   - `docs/MASTER_SPEC.md`
   - `docs/ARCHITECTURE.md`
   - `docs/REFERENCE_AUDIT.md`
   - `docs/DATA_MODEL.md`
   - `docs/AUTOPILOT.md`
   - `docs/PROVIDERS.md`
   - `docs/SETTER.md`
   - `docs/UI_SYSTEM.md`
3. Define folder architecture.
4. Define TypeScript domain types.
5. Add development seed mode.
6. Add `.env.example` with names only, never secrets.
7. Create a minimal shell UI with the visual system and sidebar.
8. Add test framework and lint/typecheck scripts.
9. Add a `/health` server endpoint or equivalent.
10. Do not yet implement all provider logic.

At the end, print:
- files created,
- key architectural decisions,
- unresolved external provider decisions,
- commands to run locally,
- exact next phase.

Do not continue into Prompt 1 automatically.

---

# PROMPT 1 — DOMAIN MODEL, SUPABASE, DEDUPLICATION, ACCOUNT/CONTACT GRAPH

Read every file in `docs/` created in Prompt 0 before changing code.

Your task in this phase is to implement the core data model and domain services. Do not build discovery APIs yet beyond mocks.

## 1.1. Core entities

Do not center the architecture on a generic `leads` table.

Implement normalized entities approximately as follows. You may adjust names if justified, but preserve the separation of concepts.

### `accounts`
A real-world business establishment/company.

Core fields:
- `id`
- `workspace_id`
- `canonical_name`
- `normalized_name`
- `business_type`
- `country_code`
- `region`
- `province`
- `city`
- `postal_code`
- `address_line`
- `normalized_address`
- `latitude`
- `longitude`
- `phone`
- `normalized_phone`
- `website_url`
- `normalized_domain`
- `google_place_id`
- `maps_url`
- `rating`
- `review_count`
- `fit_score`
- `fit_tier`
- `status`
- `created_at`
- `updated_at`

### `account_sources`
Every source that discovered or enriched the account.

Fields:
- `id`
- `account_id`
- `source_type`
- `source_provider`
- `source_external_id`
- `source_url`
- `raw_snapshot` JSONB
- `discovered_at`

### `contacts`
A person or role associated with an account.

Fields:
- `id`
- `workspace_id`
- `account_id`
- `first_name`
- `last_name`
- `full_name`
- `job_title`
- `role_type`
- `is_decision_maker`
- `seniority`
- `linkedin_url`
- `source_confidence`
- `status`
- timestamps

Role types should support:
- owner
- titular_pharmacist
- manager
- purchasing_manager
- buyer
- employee
- generic_role
- unknown

### `contact_points`
A channel endpoint belonging to a person or account.

Fields:
- `id`
- `workspace_id`
- `account_id`
- `contact_id` nullable
- `type`: email / phone / linkedin / other
- `value`
- `normalized_value`
- `label`
- `is_generic`
- `is_personal_or_named`
- `priority_score`
- `verification_status`
- `verification_provider`
- `verification_checked_at`
- `channel_eligibility`
- `source_url`
- `source_type`
- `last_contacted_at`
- `status`
- timestamps

Important:
A pharmacy can legitimately have:
- owner email
- purchasing email
- manager email
- info@ generic email
- business phone
at the same time.

These are not duplicates of one another.

### `offers`
Configurable commercial knowledge.

Fields:
- name
- company
- description
- primary_cta
- booking_url
- approved_commercial_facts JSONB
- approved_product_facts JSONB
- approved_claims JSONB
- forbidden_claims JSONB
- faq JSONB
- objection_guidance JSONB
- tone_config JSONB
- active

No setter prompt should rely on hard-coded Vitalcap claims in source code.

### `campaigns`
Defines what to find and how to contact.

Fields:
- id
- workspace_id
- offer_id
- name
- description
- status
- country_code default ES
- engine_type
- engine_config JSONB
- daily_soft_target default 50
- minimum_fit_score
- outreach_profile_id
- autopilot_enabled
- desired_channel_mix JSONB
- time_zone default Europe/Madrid
- created_at/updated_at

### `campaign_memberships`
Relationship of account/contact/contact_point to campaigns.

Must track:
- discovered via campaign
- qualified
- selected contact point
- current stage
- rejection reason
- ready_at
- contacted_at

### Queue/job tables

Implement durable job models rather than relying only on ephemeral promises.

Recommended:
- `discovery_jobs`
- `raw_candidates`
- `processing_jobs`
- `outreach_queue`
- `dead_letter_jobs`

Each job must support:
- id
- campaign
- type
- payload
- status
- attempt_count
- max_attempts
- locked_at
- locked_by
- next_attempt_at
- last_error
- timestamps

### Outreach / conversation tables

Reserve normalized tables now:
- `outreach_events`
- `conversations`
- `conversation_messages`
- `setter_drafts`
- `setter_feedback`
- `meetings`
- `suppression_entries`

## 1.2. Global dedup design

Implement a proper `DeduplicationService`.

### Account dedup signals

Strong:
1. exact Google Place ID
2. exact normalized domain
3. exact normalized phone

Composite/fuzzy:
4. normalized business name + postal code
5. normalized business name + normalized street address
6. name + geo proximity where provider data is incomplete

Do not merge accounts automatically on weak fuzzy evidence without a confidence threshold and an audit record.

Store merge history.

### Contact dedup

Strong:
- normalized email
- normalized phone
- normalized LinkedIn canonical URL

Composite:
- normalized full name + account ID

### Outreach dedup

Prevent duplicate contact attempts using:
`contact_point + campaign + channel + configurable cooldown`

Also enforce account-level concurrency:
Do not blast the owner and `info@` of the same pharmacy simultaneously unless explicitly configured.

Default behavior:
- contact highest-priority eligible endpoint first
- wait for reply / sequence outcome / cooldown
- only then consider fallback contact

## 1.3. Normalization

Implement deterministic utilities with unit tests:

- `normalizeDomain`
- `normalizeUrl`
- `normalizeEmail`
- `normalizePhoneES`
- `normalizeLinkedInUrl`
- `normalizeBusinessName`
- `normalizeAddress`
- remove tracking parameters
- normalize www/non-www
- canonicalize protocols
- Spanish accents handled carefully
- do not lose meaningful name information

## 1.4. Spain-only hard boundary

Create `SpainEligibilityService`.

Strong positive evidence:
- provider country code ES
- Spanish address
- valid Spanish postal code
- explicit Spain geo location

Supporting evidence:
- +34 phone
- `.es` domain
- Spanish province/city

Do not accept a non-Spanish account.
Ambiguous records should remain pending / require more evidence rather than be silently accepted.

Create a canonical geography dataset or internal module for:
- autonomous communities
- provinces
- municipalities/search regions as needed

The discovery layer should later consume this dataset instead of hardcoding a tiny city list.

## 1.5. Contact priority

Implement configurable scoring.

Default conceptual order:
- verified owner/titular named email: 100
- verified purchasing manager email: 95
- verified manager email: 90
- verified named professional email: 85
- compras@ / purchasing role email: 80
- gerencia@ / direccion@: 75
- pharmacy/business-specific generic: 65
- info@: 60
- other generic: lower

Keep two dimensions separate:
- strategic priority
- verification confidence

A high-priority owner email can be technically risky.
A generic info email can be technically valid.

## 1.6. Verification state

Support:
- unverified
- valid
- catch_all
- risky
- invalid
- unknown
- disposable
- bounced

Campaign config determines which states are acceptable.

Do not implement provider-specific assumptions in the core domain.

## 1.7. RLS and security

Supabase:
- workspace-scoped row-level security
- user must not access another workspace
- service-role only in server-side trusted execution
- no service key in browser
- audit privileged mutations

## 1.8. Tests

Required:
- normalizers
- strong dedup
- fuzzy dedup threshold behavior
- same-account multiple contacts allowed
- outreach concurrency lock
- Spain eligibility
- contact priority
- suppression behavior
- RLS sanity tests where feasible

## 1.9. Completion criteria

Create migrations and seed data.

Seed realistic synthetic Spanish examples:
- independent pharmacy with owner + info email
- pharmacy with only generic email
- herbal shop
- sports nutrition store
- duplicate account discovered from two sources
- invalid non-Spain record
- account with two decision makers

UI should show seeded Accounts and Contacts but no real external calls yet.

Do not continue into Prompt 2 automatically.

---

# PROMPT 2 — DISCOVERY ENGINES, WEBSITE ENRICHMENT, EMAIL DISCOVERY, AUTOPILOT TARGET ENGINE

Read all docs and the completed domain model first.

This phase implements discovery and target fulfillment.

## 2.1. Discovery interface

Create a shared engine contract similar to:

- validate config
- plan discovery batch
- execute discovery
- normalize candidates
- persist source evidence
- emit raw candidates
- report provider usage/cost/latency
- support dry run

`SearchService` / `DiscoveryRouter` should be thin.
Engine-specific logic stays in engine modules.

Implement:
- `MapsFastEngine`
- `MapsDeepEngine`
- `GoogleSerpEngine`
- `LinkedInOwnerEngine`
- `HybridFillEngine`

## 2.2. Geography planner

Implement a Spain coverage planner.

It must:
- rotate provinces / municipalities / geographic cells
- remember search history
- avoid repeatedly querying the same seed with no new value
- track exhaustion / diminishing yield
- prioritize regions with remaining opportunity
- support per-campaign include/exclude regions later

Data model:
- `search_seeds`
- `search_seed_runs`
or equivalent.

Each seed should track:
- query
- engine
- geography
- last_run_at
- total_raw
- total_unique
- total_ready
- yield_rate
- exhaustion_score
- next_eligible_at

## 2.3. Maps Fast

Inputs:
- business categories / query terms
- geography
- page/continuation state
- provider limits

Raw fields where available:
- external place ID
- business name
- category
- address
- website
- phone
- coordinates
- rating
- review count
- source URL

Pipeline:
1. provider result
2. Spain check
3. pre-flight dedup
4. account upsert/source attach
5. basic business-type normalization
6. website fetch if available
7. email extraction
8. verification
9. create prioritized contact points
10. campaign membership
11. ready evaluation

Do not invoke expensive LLM classification for obvious pharmacies.
Use deterministic rules first.
Use AI only for ambiguous classification if configured.

## 2.4. Maps Deep

After base Maps discovery:
- crawl website with strict limits
- discover internal pages:
  - contact/contacto
  - about/nosotros
  - team/equipo
  - legal notice/aviso legal
  - privacy
  - pharmacy-specific owner/titular pages
- parse mailto links and visible emails
- extract business/legal names
- identify public named people/roles
- launch targeted SERP queries for:
  - business name + titular
  - business name + propietario
  - business name + gerente
  - domain + name
  - business + LinkedIn
- attach evidence source for every discovered named contact

Do not invent a person because an LLM says a likely owner name.
Every named contact requires a public source record.

## 2.5. Safe website fetching

Website crawler must include SSRF defenses:
- only http/https
- block localhost/private/link-local IP ranges
- DNS revalidation where practical
- request timeout
- content length limit
- HTML-only for this pipeline
- redirect limit
- user-agent
- max pages per domain
- deduplicate URLs
- no browser login automation
- respect provider / infrastructure constraints

Cache domain fetches to avoid repeated crawling across campaigns.

## 2.6. Email extraction

Extract all candidate emails, not only one.

For each:
- normalize
- source URL
- visible context / source label
- role prefix
- named-vs-generic classification
- priority score
- verification state

False-positive filtering:
- assets
- example/test emails
- no-reply
- obvious platform support emails unrelated to account
- image filenames accidentally matching email regex
- unrelated third-party footer vendors

Do not automatically discard `info@` because it is generic.
For pharmacies it can be valuable.

## 2.7. Email verification

Create provider adapter + development mock.

Batch when provider supports batching.
Cache verification results.
Do not repeatedly pay to revalidate unchanged email within a configured TTL.

Track:
- verification cost
- result
- provider raw code
- checked_at
- expires_at

## 2.8. Google SERP engine

Build query expansion.

Example dimensions:
- category:
  farmacia, farmacia independiente, parafarmacia, herbolario, tienda de suplementos, nutrición deportiva, tienda fitness, complementos alimenticios
- geography:
  municipality, province
- intent signals:
  suplementos, complementos, nutrición, vitaminas, bienestar

Do not explode combinatorially without yield tracking.
Search planner should choose high-yield combinations.

Parse:
- title
- URL
- snippet
- domain
- possible business name
- possible location

Then:
domain/site -> account resolution -> Spain -> dedup -> enrichment -> contact points.

## 2.9. LinkedIn Owner engine

Use public SERP discovery.

Example role families:
- "titular farmacéutico"
- "titular farmacia"
- "propietario farmacia"
- "dueño farmacia"
- "gerente farmacia"
- "responsable de compras farmacia"
- equivalents

Use queries such as public web search for LinkedIn profile URLs.
Do not require authenticated LinkedIn scraping.

Pipeline:
profile/snippet
-> normalize person
-> identify employer/business
-> resolve business website/domain/location
-> verify Spain
-> account dedup
-> contact creation
-> public contact point discovery
-> email verification
-> ready evaluation

Do not generate guessed personal email patterns unless the workspace explicitly enables a separate experimental mode. Default is public-source discovery + verification.

## 2.10. Hybrid Fill engine

This is not just a fifth static search source.

Inputs:
- global daily deficit
- engine deficits
- provider health
- provider cost
- current queue depths
- seed yields
- ready buffer depth
- current time in Europe/Madrid

Possible actions:
- run extra high-yield Maps Fast seeds
- expand Google regions
- deepen incomplete accounts that have website but no email
- search owner for high-fit accounts
- broaden retail category within accepted campaign scope
- retry temporary provider failures
- use healthy alternative provider

Must log why it chose an action.

## 2.11. Autopilot Target Engine

Create a dedicated service, not random cron conditionals scattered throughout providers.

Recommended components:
- `AutopilotScheduler`
- `TargetPlanner`
- `QuotaRebalancer`
- `QueueHealthService`
- `ProviderHealthService`
- `PacingService`

Campaign state:
- daily soft target
- ready today
- sent today
- deficit
- ready buffer
- average yield
- provider health
- next run

Global:
- daily target 250 by default
- ready count
- send count
- deficit
- channel capacity
- remaining time in send window

### Pacing

Do not wait until the final hour to discover a huge deficit.

Example target trajectory can be proportional to the campaign's configured operating window.

If significantly behind trajectory:
- increase discovery batch
- pick high-yield seeds
- invoke hybrid fill
- reduce backoff where provider health allows

If ahead:
- reduce expensive discovery
- protect provider credits
- build buffer only up to configured target

### Rebalancing

Every engine has a soft target.
Global target is more important.

At rebalance checkpoints:
1. calculate each engine deficit
2. estimate available yield
3. reallocate global remaining target to healthy engines
4. preserve source diversity where practical
5. do not lower quality thresholds below campaign config merely to fill numbers

### Target unit

Default engine success metric should be:
`outreach_ready_unique_contact_opportunity`

Not raw profile.
Not raw map listing.
Not merely email found.

## 2.12. Queue behavior

Jobs must be:
- idempotent
- retryable
- lock-safe
- resumable
- observable

Use exponential backoff for transient provider errors.
Do not retry permanent errors indefinitely.
Dead-letter after configured attempts.

Handle cron overlap:
- lease/lock jobs
- atomic claim
- no two workers process same job simultaneously

## 2.13. Provider credit guards

Track usage:
- calls
- items
- errors
- latency
- daily/monthly cost if available
- quota remaining if provider exposes it

If provider is unhealthy/out of credits:
- pause that adapter
- do not burn downstream work on records that cannot complete
- allow hybrid engine to choose another path

## 2.14. Autopilot UI acceptance

Autopilot page must show:

Top:
- Today: `ready / 250`
- contacted today
- replies
- meetings
- ready buffer days
- system health

Five engine cards:
- name
- status
- `current / soft target`
- projected finish
- ready queue
- raw queue
- current yield
- provider health
- last run
- next planned action

A central progress visualization should feel like the supplied clean orange dashboard references.

Show a small "Rebalancing" activity stream:
- "LinkedIn Owner behind target by 18"
- "Allocated +10 to Maps Fast"
- "Allocated +8 to Google SERP"
etc.

Do not use terminal-looking logs as the main UI.
Raw logs may exist in a secondary drawer.

## 2.15. Completion criteria

A fully mocked/local environment must demonstrate:
- five engines producing synthetic candidates
- global dedup
- targets
- soft-target shortfall
- rebalancing
- hybrid fill
- queue retries
- provider outage
- 250 daily target simulation
- buffer generation

No real sending in this phase.

---

# PROMPT 3 — OUTREACH INFRASTRUCTURE, EMAIL, SMS, CHANNEL ROUTER, SUPPRESSION

Read all existing docs and code first.

This phase turns qualified opportunities into safe, idempotent outreach jobs.

## 3.1. Separate "ready prospect" from "sent"

An account/contact can be outreach-ready without being currently sendable.

Reasons:
- sender pool has no capacity
- compliance gate blocks channel
- account cooldown
- suppression
- campaign paused
- no eligible endpoint
- provider temporarily down

Never fake target completion by counting attempted but blocked sends.

## 3.2. ChannelRouter

Implement a deterministic routing service.

Inputs:
- campaign desired channel mix
- account/contact priorities
- verified endpoints
- eligibility
- sender capacity
- contact history
- account concurrency
- opt-out/suppression
- cost/campaign rules

Default email endpoint preference:
1. owner/titular named email
2. purchasing manager
3. manager
4. other named professional
5. compras@ / role email
6. pharmacy-specific generic
7. info@

Default:
one active cold outreach path per account at a time.

Do not simultaneously send to:
owner@example.com + info@example.com
unless explicitly configured.

## 3.3. Email delivery

Create `EmailDeliveryProvider`.
Primary production adapter may be Instantly if configured.

The adapter should support:
- add lead / schedule into campaign
- provider lead ID
- workspace/campaign ID
- custom variables
- skip-if-existing behavior where provider supports it
- status sync
- bounce
- reply
- unsubscribe
- campaign/sender assignment

Do not hardcode an Instantly campaign ID.

Create UI mapping:
internal outreach campaign -> provider campaign ID.

## 3.4. Sender pool

Data model:
- `sending_domains`
- `mailboxes`
- provider account ID
- email
- domain
- status
- warmup status
- daily capacity
- sent today
- bounce rate
- reply rate
- health score
- paused reason

Do not hardcode a fixed emails-per-mailbox number.
Capacity is configurable and can change as infrastructure matures.

The scheduler must not exceed per-mailbox or global campaign capacity.

The application does not need to purchase domains automatically.
It should manage/configure the infrastructure after the user creates/connects it.

## 3.5. SMS

Create `SmsDeliveryProvider`.

Textvy may later be used, but do not invent its API.
If official API documentation is not available, ship an adapter interface + mock and clearly document what is missing.

Model:
- SMS sender/SIM/provider
- capacity
- phone
- delivery status
- reply
- opt-out
- failure codes
- message segments/cost if provider returns them

Normalize Spanish phone numbers to E.164.

Do not assume every Maps phone is a mobile.
Classify phone type where reliable.
Channel eligibility is independent from phone existence.

## 3.6. Desired 125/125 mix

Support campaign/workspace target mix such as:
- email: 50%
- sms: 50%

This is a preference.

Routing algorithm:
1. calculate daily remaining send capacity per channel
2. select eligible contact opportunities
3. try to approach target mix
4. if one channel lacks eligible capacity, report shortfall or reallocate only if campaign configuration permits
5. never bypass suppression/eligibility just to hit 125

UI should show:
- desired mix
- actual mix
- blocked by eligibility
- blocked by capacity
- no endpoint
- paused

## 3.7. Universal suppression

Create one workspace-wide suppression service.

Triggers:
- explicit unsubscribe
- SMS STOP equivalent
- permanent bounce
- manual block
- legal/compliance block
- account-level do-not-contact
- provider unsubscribe

Before every send:
check suppression.

No adapter may bypass it.

## 3.8. Outreach events

Every lifecycle transition should be stored:
- queued
- provider_submitted
- sent
- delivered if available
- bounced
- replied
- unsubscribed
- failed
- canceled

Store provider event ID and payload hash for idempotency.

Webhook ingestion must:
- verify signature/shared secret where provider supports it
- deduplicate event ID
- be replay-safe
- update aggregate state transactionally

## 3.9. Sequences

Separate:
- cold sequence
- warm follow-up after positive/engaged reply

Do not send a scheduled cold follow-up if the lead already replied.

Account-aware pause:
any reply from an account should pause other active cold paths for that account until routed.

## 3.10. Infrastructure UI

Page: `Infrastructure`

Sections:
- Domains
- Mailboxes
- Email provider
- SMS provider/SIMs
- Verification provider
- Search providers
- LLM
- Webhooks
- Provider usage

Visual style:
clean white cards, warm background, orange active states.
Provider status rows:
Connected / Degraded / Paused / Missing configuration.

No secret values displayed after save.

## 3.11. Outreach UI

Top metrics:
- scheduled today
- sent today
- email / SMS split
- bounces
- replies
- opt-outs

Queue table:
- account
- contact
- endpoint
- channel
- campaign
- priority
- eligibility
- scheduled time
- state

Filters:
- channel
- campaign
- engine source
- status
- account type
- region/province

## 3.12. Dry run

Before enabling production:
support `delivery_mode = dry_run`.

In dry run:
- route
- assign sender
- render message
- record planned event
- do NOT call provider

Use this for end-to-end validation.

---

# PROMPT 4 — AI SETTER, REPLY CLASSIFICATION, HUMAN REVIEW, LEARNING LOOP

Read all existing docs first.

Build the AI Setter as a configurable product subsystem, not a brand-specific hard-coded webhook.

## 4.1. Reply ingestion

Email and SMS replies should normalize into the same conversation domain.

Conversation:
- account
- contact
- campaign
- offer
- channel
- provider thread IDs
- state
- latest intent
- latest setter status

Message:
- direction incoming/outgoing
- body
- provider IDs
- timestamp
- channel
- metadata

Reply webhook must be idempotent.

## 4.2. Deterministic pre-router

Before calling the LLM, detect high-confidence deterministic cases:

- unsubscribe / stop
- explicit do-not-contact
- hard negative
- out-of-office
- bounce/system message
- meeting already booked
- wrong person / forward request
- contact details supplied
- obvious spam/provider automated message

These can alter state before AI drafting.

Do not let the LLM override a suppression event.

## 4.3. Initial Vitalcap branch catalog

Keep branches configurable in DB.

Initial branch concepts:
- `INTEREST`
- `SEND_INFO`
- `MARGIN`
- `PRICE`
- `MINIMUM_ORDER`
- `PRODUCT_DETAILS`
- `EXISTING_SUPPLIER`
- `SAMPLES`
- `CREDIBILITY`
- `NOT_DECISION_MAKER`
- `FORWARD_TO_PURCHASING`
- `CALL_ME_LATER`
- `MEETING_REQUEST`
- `LOGISTICS`
- `COMMERCIAL_TERMS`
- `NOT_INTERESTED`
- `UNSUBSCRIBE`
- `UNKNOWN`
- `HUMAN_REQUIRED`

Do not assume all branches should have automatic replies.

## 4.4. Setter context

Build prompt context from configuration:
- offer
- approved commercial facts
- approved product facts
- approved claims
- forbidden claims
- FAQ
- objection guidance
- primary CTA
- booking URL
- tone
- account information
- contact role
- discovery source
- previous conversation messages
- relevant recent human feedback

Do not include unrelated full database dumps.

## 4.5. Strict AI output

Use structured output schema, e.g.:
- language
- branch
- intent_summary
- confidence
- draft
- needs_human
- reason_for_human
- detected_facts_requested
- risk_flags
- suggested_next_action

Validate with Zod.

If invalid:
- retry once with repair prompt if appropriate
- otherwise create human-required draft state

## 4.6. Guardrails

AI must never invent:
- medical/therapeutic claims
- certifications
- stock
- shipping times
- minimum order
- pricing
- margin
- exclusivity
- historical sales
- pharmacy performance
- legal/regulatory status
- distribution terms
unless explicitly present in approved campaign knowledge.

Special commercial negotiation:
If the reply asks for non-approved price, special margin, exclusivity, territory, custom terms or large-volume agreement:
classify and hand to human.

The CTA is booking/speaking with the sales director when appropriate.

Keep replies:
- concise
- natural Spanish by default
- same language as lead where practical
- one clear CTA
- no over-explaining
- no fake familiarity
- no unnecessary emoji
- no claims of having performed actions that were not performed

## 4.7. Human-in-the-loop

Initial mode:
100% AI drafts require review before sending.

Review actions:
- Approve
- Edit & Send
- Reject
- Mark no reply needed
- Escalate
- Suppress

Store:
- original AI draft
- final human text
- action
- correction reason
- branch correction
- timestamp
- reviewer

## 4.8. Setter feedback

Create structured feedback.

Fields:
- conversation/message ID
- predicted branch
- corrected branch
- AI draft
- corrected text
- decision
- reason category
- free-form note
- meeting outcome if later known
- qualified yes/no
- lost reason

Use recent, relevant feedback as context, but do not create uncontrolled prompt growth.

Create analytics:
- branch accuracy
- approval rate
- edit rate
- rejection rate
- positive reply -> meeting
- average edits
- confidence calibration

## 4.9. Progressive autonomy

Prepare policy engine but keep disabled initially.

Possible policy later:
- branch allowlist
- minimum confidence
- no risk flags
- contact type constraints
- campaign-level toggle

Example:
`auto_send_enabled = false` globally by default.

A branch can only auto-send when:
- campaign permits
- branch permits
- confidence threshold met
- validator passes
- no restricted topics
- no risk flags

Never silently activate autosend.

## 4.10. Review UI

Page `Reviews`.

Visual concept:
three-column desktop layout if width permits:

Left:
conversation list with status chips

Center:
thread

Right:
AI analysis + draft + controls

Controls:
- approve
- edit
- reject
- escalate
- suppress

Show:
- branch
- confidence
- contact/account
- campaign
- source
- approved facts referenced
- risk flags

The UI should look like a premium CRM inbox, using the warm white/orange design language.

## 4.11. AI Setter page

Dashboard-style:
- pending review
- approved today
- edited today
- rejected
- meetings generated
- branch accuracy
- top objections
- response latency

Include branch performance table.

## 4.12. Warm follow-up

Separate warm follow-up scheduler.

A positive/interested lead that has not booked may enter a warm follow-up queue.

Do not mix this with cold follow-up state.

Pause immediately on:
- reply
- meeting
- unsubscribe
- human ownership

---

# PROMPT 5 — FULL FRONTEND / UX / VISUAL SYSTEM

Read `docs/UI_SYSTEM.md`, the product spec and current backend schema.

The attached reference images define the target visual quality:
- clean operational dashboards
- fixed left navigation
- warm white/ivory canvas
- orange as primary accent
- crisp cards
- soft rounded edges
- subtle shadows
- dense but readable information
- useful dashboard composition
- premium B2B SaaS feel

Do not copy their brand names, exact screen composition or proprietary visual details.

## 5.1. Global layout

Desktop first:
- sidebar 220–250px
- collapsible to icon rail
- top bar 56–64px
- main content max width flexible/full
- app background warm ivory
- white panels

Sidebar:
- logo/product wordmark at top
- nav grouped logically
- active item uses pale orange background + orange icon/text accent
- numeric badges for actionable counts
- settings and user profile near bottom

Topbar:
- page title/context
- optional search
- system status
- notification bell/activity
- user/avatar
- compact primary action only when relevant

## 5.2. Design tokens

Use CSS variables.

Suggested:
- `--background: #F7F4EF`
- `--surface: #FFFFFF`
- `--surface-muted: #FBF9F6`
- `--border: #E8E3DC`
- `--text: #171717`
- `--text-muted: #6F6B66`
- `--primary: #F26A21`
- `--primary-hover: #DD5B17`
- `--primary-soft: #FFF1E7`
- semantic success/warning/danger in restrained tones

Radius:
- controls 8–10px
- cards 12–16px

Shadow:
very soft, low-opacity.

No heavy outlines everywhere.
Use spacing and grouping.

## 5.3. Dashboard

The first screen must immediately answer:
- Are we on target today?
- Are providers healthy?
- Are we generating enough ready prospects?
- Are we sending?
- Are people replying?
- Are meetings being booked?

Header:
`Good morning/afternoon, <name>`
date / daily status

Primary row:
- Daily target: 250
- Ready today
- Sent today
- Replies
- Meetings

Large card:
Autopilot progress
- total progress bar/graph
- time trajectory
- expected target line if useful

Engine overview:
five compact cards with:
- icon
- target
- current
- status
- yield
- short action
- progress

Activity/right rail:
- provider alerts
- target rebalance
- reply needing review
- mailbox issue
- verification quota warning

Secondary:
- weekly reply/meeting trend
- channel mix
- funnel
- top campaign performance

Avoid 20 equally prominent KPI cards.

## 5.4. Campaigns

Use a clean table/card hybrid.

Columns:
- Campaign
- Engine
- Status
- Soft target
- Today
- Ready buffer
- Channel mix
- Reply rate
- Meetings
- Health
- actions menu

Campaign detail tabs:
- Overview
- Engine config
- Target & schedule
- ICP
- Outreach
- Setter
- Activity
- Settings

Campaign creation should be a guided form, not a giant raw JSON editor.

Advanced JSON config can live under an "Advanced" accordion.

## 5.5. Autopilot page

This is a flagship screen.

Top banner:
- global target progress
- current time
- projected completion
- buffer days
- system health

Engine lane cards:
Maps Fast
Maps Deep
Google SERP
LinkedIn Owner
Hybrid Fill

Each lane shows:
- target 50
- achieved
- raw queue
- processing
- ready
- error count
- current yield
- last action
- next action

Middle:
"Target Allocation"
visual representation of original 50/50/50/50/50 and current rebalanced targets.

Bottom:
- recent rebalance decisions
- queue health
- provider health
- dead letter warnings

Include controls:
- pause/resume autopilot
- emergency stop all outbound
- do not include a prominent manual lead generator

## 5.6. Discovery page

Show engines and underlying search coverage.

Sections:
- provider health
- geographic coverage
- high-yield search seeds
- low-yield/exhausted seeds
- queue depth
- discovered today

Optional Spain map visualization if useful, but not required for MVP.

Filter by:
- engine
- province
- business type
- status

## 5.7. Accounts

Table:
- business
- type
- city/province
- website
- best contact
- contact count
- fit
- source badges
- campaign count
- outreach state

Click opens detail drawer/page.

Account detail:
- identity
- source evidence
- contact graph
- website/enrichment
- campaigns
- outreach history
- conversations
- notes
- dedup/merge history

## 5.8. Contacts

Table:
- person/role
- account
- role
- best endpoint
- endpoint verification
- priority
- LinkedIn
- source
- status

Generic account-level contacts should visually differ from named people.

## 5.9. Outreach

Operational queue with tabs:
- Scheduled
- Sent
- Replies
- Failed
- Suppressed

Email/SMS mix chart.
Sender pool health.
Bounce/opt-out alerts.

## 5.10. AI Setter

Inbox-like screen.

Left:
- filters
- conversations
- unread/pending badges

Center:
- conversation timeline

Right:
- account/contact card
- AI intent
- branch
- confidence
- draft
- approval controls

No chatbot bubble gimmicks that hide operational information.

## 5.11. Reviews

Optimized for speed.

Keyboard shortcuts optional:
- approve
- edit
- reject
- next

Never trigger send from one accidental keypress without clear affordance/confirmation policy.

## 5.12. Analytics

Funnel:
raw -> unique -> verified -> ready -> sent -> reply -> positive -> meeting

Break down by:
- engine
- campaign
- business type
- province
- channel
- contact type
- generic vs named
- owner vs role-based

Important comparative metrics:
- cost per ready lead
- reply rate
- positive rate
- meeting rate
- provider cost
- enrichment yield
- verification yield

Do not create a single "best engine" score that hides underlying tradeoffs.
Show factual metrics.

## 5.13. Infrastructure

Cards + table:
- domains
- mailboxes
- Instantly/Email provider
- SMS provider
- verification
- SERP
- Maps
- LLM
- webhooks

Show:
- connected
- missing
- degraded
- quota
- last successful call

## 5.14. Loading / empty / error states

Every screen needs:
- skeleton loading
- useful empty state
- retriable errors
- no giant red error dumps
- provider-specific detail available under expandable technical diagnostics

## 5.15. Responsive behavior

Desktop is primary.
Tablet supported.
Mobile:
- collapsible navigation
- stack cards
- tables become horizontally scrollable or card rows
- reviews remain usable

Do not sacrifice desktop information density to force a mobile-first design.

## 5.16. UI acceptance

At 1440x900:
- no excessive blank space
- core metrics visible above fold
- sidebar and page hierarchy obvious
- visual quality should feel close to the attached premium dashboard examples
- orange accent restrained
- no repo-like developer UI
- no debug screens in main navigation

Take screenshots or use visual tests if the environment supports it.

---

# PROMPT 6 — QA, OBSERVABILITY, FAILURE MODES, PRODUCTION HARDENING, RELEASE

Read the entire repository and docs.

Do not add major new features in this phase.
Make the system reliable.

## 6.1. End-to-end critical flows

Test:

### Flow A — Maps Fast
discover Spanish pharmacy
-> normalize
-> dedup
-> crawl website
-> find info@
-> verify
-> ready
-> channel route
-> dry-run send

### Flow B — Maps Deep
discover account
-> owner public evidence
-> owner email
-> verify
-> priority selection
-> do not also contact info@ concurrently

### Flow C — Duplicate
same pharmacy discovered by Maps + Google
-> one account
-> two source records
-> contacts merged safely
-> no duplicate send

### Flow D — Spain boundary
result in Portugal/France/Andorra
-> rejected/not eligible

### Flow E — Engine underperformance
LinkedIn gets 20/50
-> rebalancer shifts target
-> global reaches simulated 250 using healthy engines

### Flow F — Provider outage
verification provider down
-> jobs retry
-> no data loss
-> health alert
-> no invalid sends

### Flow G — Reply
provider webhook
-> idempotent conversation message
-> deterministic checks
-> AI draft
-> review
-> edit
-> send in same thread

### Flow H — Unsubscribe
reply asks to stop
-> suppression
-> all active cold sequence canceled
-> no AI response that continues selling

### Flow I — Setter restricted claim
lead asks non-approved commercial/medical question
-> human required
-> no hallucinated answer

## 6.2. Observability

Build operational metrics:
- discovery calls
- raw yield
- unique yield
- enrichment success
- email find rate
- verification success
- ready rate
- send rate
- bounce
- reply
- meeting
- queue latency
- dead-letter count
- provider latency/errors
- provider cost

Structured logs:
- correlation ID
- job ID
- campaign ID
- account ID when relevant
- provider
- duration
- outcome

Never log secrets.
Avoid logging full personal data unnecessarily.

## 6.3. Admin diagnostics

Provide a protected diagnostics view or server endpoint:
- queue counts
- stuck jobs
- provider health
- cron last run
- webhook last event
- DB connectivity
- current target state

Not visible as a normal salesperson screen.

## 6.4. Idempotency audit

Verify:
- duplicate cron run
- duplicate provider webhook
- duplicate raw candidate
- duplicate email verification callback if any
- retry after timeout
- worker crash after provider success but before DB commit

Use unique constraints / idempotency keys where possible.

## 6.5. Database constraints

Add:
- unique indexes for normalized strong identities where safe
- partial indexes for active queue queries
- foreign keys
- enum/check constraints or validated text states
- indexes for dashboard queries
- indexes for time-based queue processing

Run EXPLAIN on critical queries if supported.

## 6.6. Security review

Check:
- RLS
- service key exposure
- webhook verification
- SSRF
- open redirects
- unsafe HTML rendering
- secret handling
- provider key storage
- rate limiting
- authorization on mutation endpoints
- user/workspace isolation

## 6.7. Performance

Avoid:
- N+1 account/contact queries
- re-crawling same domain repeatedly
- repeated verification
- unbounded cron processing
- giant JSON payloads in UI
- synchronous provider chains in request/response paths

Use pagination.

## 6.8. Recovery

Document:
- how to pause outbound globally
- how to pause a campaign
- how to resume dead-letter jobs
- how to rotate provider keys
- how to disable a provider
- how to recover from a bad deployment
- how to replay webhooks safely
- how to rerun a daily target without duplicate sends

## 6.9. Production environment checklist

Create `docs/PRODUCTION_CHECKLIST.md`.

Include:
- Supabase project configured
- migrations applied
- RLS verified
- auth callback URLs
- Vercel env vars
- cron secret
- provider keys
- webhooks
- Instantly campaign mappings
- sending domains/mailboxes
- warmup/capacity entered
- email verifier
- Maps/SERP provider
- SMS adapter configured or explicitly disabled
- booking URL
- approved offer facts reviewed
- sender identity/signature
- suppression test
- dry run passed
- emergency stop tested

## 6.10. Release rule

Do not enable real outbound by default.

Production should start with:
- discovery live
- enrichment live
- verification live
- delivery dry run

Then an authorized user explicitly changes:
`delivery_mode: live`

AI Setter starts:
`human_review_required: true`

`auto_send_enabled: false`

## 6.11. Final deliverable

At completion, produce:
- architecture summary
- provider matrix
- schema overview
- route/page inventory
- test results
- known limitations
- deployment guide
- production checklist
- first-week operating procedure

Do not claim a provider is connected unless it was actually tested.

---

# APPENDIX A — RECOMMENDED DOMAIN/SERVICE STRUCTURE

This is a direction, not an unbreakable exact path:

```text
src/
  app/
    (dashboard)/
    api/
  components/
    ui/
    layout/
    dashboard/
    autopilot/
    campaigns/
    accounts/
    contacts/
    outreach/
    setter/
  domain/
    accounts/
    contacts/
    campaigns/
    discovery/
    autopilot/
    outreach/
    conversations/
    compliance/
  services/
    deduplication/
    enrichment/
    verification/
    routing/
    setter/
  infrastructure/
    supabase/
    providers/
      maps/
      serp/
      email-verification/
      instantly/
      sms/
      llm/
    jobs/
  lib/
    normalization/
    validation/
    geography/
    security/
  types/
  tests/
docs/
```

Keep business logic out of React components and API route files.

---

# APPENDIX B — CORE STATE MACHINES

## Account processing

```text
discovered
-> normalized
-> deduped
-> country_verified
-> enriched
-> qualified
-> contactable
-> outreach_ready

Possible terminal/side states:
rejected_country
rejected_icp
duplicate_merged
needs_review
no_contact_found
archived
```

## Contact point

```text
discovered
-> normalized
-> unverified
-> valid/catch_all/risky/invalid
-> eligible/ineligible
-> selected
-> queued
-> contacted
```

## Outreach

```text
queued
-> scheduled
-> provider_submitted
-> sent
-> delivered
-> replied

side states:
failed
bounced
unsubscribed
canceled
suppressed
```

## Setter

```text
reply_received
-> pre_routed
-> ai_classified
-> draft_ready
-> pending_review
-> approved/edited/rejected/escalated
-> sent

side:
no_reply_needed
suppressed
meeting_booked
human_owned
```

---

# APPENDIX C — NON-NEGOTIABLES

1. Spain only for the initial prospecting campaigns.
2. Autopilot is the main workflow.
3. Five discovery engines with shared domain models.
4. 50 per engine is soft; 250 global is primary.
5. Do not sacrifice quality or dedup to display fake quota completion.
6. Producer and processor are separate.
7. Maintain ready inventory buffer.
8. Accounts, contacts and contact points are separate entities.
9. Global dedup before expensive enrichment whenever possible.
10. Multiple valid contacts per account are allowed.
11. Do not contact several endpoints at the same account simultaneously by default.
12. No Apollo dependency for primary owner discovery.
13. Email verification provider abstraction.
14. Public-source evidence for named decision makers.
15. Email/SMS eligibility separate from existence of endpoint.
16. Universal suppression before every send.
17. No hard-coded campaign IDs, URLs, product facts, margins, prices or claims.
18. Human review for Setter at launch.
19. Setter never invents medical/commercial facts.
20. Every external webhook is idempotent.
21. Every queue job is retryable and observable.
22. UI must be premium warm white/orange, not a developer-looking clone of the old repositories.
23. Manual generator is not a core product screen.
24. Secrets never go to the client.
25. Real outbound is disabled until explicit go-live.

---

# APPENDIX D — FIRST PRODUCTION CAMPAIGN PRESET

Create a seed campaign template, disabled by default:

Name:
`Vitalcap - Pharmacies Spain - Maps Fast`

- country: ES
- engine: maps_fast
- autopilot: off by default until configuration complete
- soft target: 50
- target business types:
  - pharmacy
  - parapharmacy
- geography: Spain
- offer: Vitalcap
- primary CTA: configurable sales-director booking URL
- endpoint preference: owner/titular if already known, otherwise pharmacy generic email
- desired channel mix: configurable
- AI Setter: human review required
- delivery mode: dry_run

Also create disabled templates:
- Vitalcap - Maps Deep
- Vitalcap - Google SERP
- Vitalcap - LinkedIn Owners
- Vitalcap - Hybrid Fill

The user can activate each only after provider credentials and campaign mappings are ready.
