# PHASE 8L.2.1: RUNTIME CONFIG DECOUPLING + UI RESTORE

## 1. Problem Statement
The application was crashing in production on every request. The root cause was that `middleware.ts` relied on `getServerEnv()`, a monolithic configuration getter that validated the entirety of the application's environment schema upon module initialization.
Because the Vercel production environment lacked `APIFY_API_TOKEN` and a valid `NEON_AUTH_COOKIE_SECRET`, the Zod validation threw an error, crashing the middleware and preventing even the fallback login screen or UI from rendering.

## 2. Changes Made
### 2.1 Granular Environment Readers
We decoupled the environment variables by refactoring `src/lib/config/env.ts` into multiple domain-specific configuration readers:
- `getCoreEnv`: For base App configurations, Vercel context, dev seed mode.
- `getDatabaseEnv`: For Postgres / Neon configuration.
- `getMapsEnv`: For Maps Discovery (Apify).
- `getSerperEnv`: For SERP providers.
- `getIntelligenceEnv`: For LLM configuration (OpenAI).
- `getVerificationEnv`: For Email Verification (Millionverifier).
- `getDeliveryEnv`: For Outbound Delivery (Instantly).

### 2.2 Re-architecting Middleware
The middleware and authorization contexts were updated to use `getAuthEnv` and `getCoreEnv` explicitly. This ensures that a missing configuration in a downstream service (like Apify) will not block the initial boot process or the core request routing.

### 2.3 Provider Isolation
We updated job runners and background processors across the application (e.g. `autopilot-runner.ts`, `provider-runs-runner.ts`, `diagnostics.ts`, `smoke-maps.ts`) to use only the localized config getters relevant to their operations.
If `APIFY_API_TOKEN` is missing, only Maps Discovery will log a type-safe failure.

### 2.4 Health Check Updates
Re-implemented the `/api/health` route with safe configuration probes. Instead of wrapping the monolithic loader in a try/catch, it now evaluates each subsystem's getter. Missing tokens correctly mark that specific capability as `configured: false` or `status: "degraded"` rather than blowing up the entire endpoint.

### 2.5 Secret Injection
Generated a new 32-character, cryptographically secure `NEON_AUTH_COOKIE_SECRET` and pushed it directly to the Vercel Production and Preview environments to satisfy Better Auth's minimum security requirements.

## 3. Verification
1. `npm test` and `npm run typecheck` run successfully.
2. Build completes successfully without static generation errors related to env dependencies.
3. `/api/health` tests confirm it can render partially degraded states without throwing.
4. Changes pushed to GitHub, which should trigger a new Vercel deployment. Operators should verify Vercel logs to confirm UI restoration.

## 4. Pending Operator Actions
**OPERATOR REQUIRED:**
- **APIFY_API_TOKEN:** The Maps Provider API key must be configured in Vercel as `APIFY_API_TOKEN`. No code-level fallback was added for the legacy variable name per instructions. Maps discovery will gracefully fail until this token is manually injected or migrated in the Vercel environment dashboard.
