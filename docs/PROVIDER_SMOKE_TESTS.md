# Provider Smoke Tests

Operator-only scripts that make one small, bounded, **real** call to each
production provider adapter. None of these are wired into `npm test`,
`npm run build`, or any CI workflow — they require real credentials and
real (small) spend, and must only be run manually by an operator.

| Script | Command | Provider | Requires |
|---|---|---|---|
| `scripts/smoke/smoke-maps.ts` | `npm run smoke:maps` | Apify (`ApifyMapsDiscoveryProvider`) | `APIFY_API_TOKEN` |
| `scripts/smoke/smoke-serper.ts` | `npm run smoke:serper` | Serper.dev (`SerperDiscoveryProvider`) | `SERPER_API_KEY` |
| `scripts/smoke/smoke-email-verification.ts` | `npm run smoke:email-verification` | MillionVerifier (`MillionVerifierEmailVerificationProvider`) | `MILLIONVERIFIER_API_KEY` |
| `scripts/smoke/smoke-db.ts` | `npm run smoke:db` | Neon Postgres connectivity | `DATABASE_URL` — **not yet implemented** |
| `scripts/smoke/smoke-auth.ts` | `npm run smoke:auth` | Neon Auth | `NEON_AUTH_*` — **not yet implemented** |
| `scripts/smoke/smoke-instantly.ts` | `npm run smoke:instantly` | Instantly v2 | `INSTANTLY_API_KEY` — **Gate F, not yet implemented** |
| `scripts/smoke/smoke-llm.ts` | `npm run smoke:llm` | OpenAI (real LLM setter) | `LLM_PROVIDER_API_KEY` — **Gate F, not yet implemented** |

## Gate D coverage

The three implemented scripts each run exactly one bounded real call
(1 Actor run capped at 5 results for Maps, 1 query for Serper, 2 email
lookups for MillionVerifier) and print the mapped domain-shaped result plus
measured cost/latency — enough to confirm credentials + endpoint mapping
are correct before enabling `MAPS_PROVIDER=apify` /
`SERP_PROVIDER=serper` / `EMAIL_VERIFICATION_PROVIDER=millionverifier` in
any real environment.

## Known gap

`smoke-db.ts`, `smoke-auth.ts` (Gate B), and `smoke-instantly.ts` /
`smoke-llm.ts` (Gate F) are referenced by `package.json` but not yet
implemented. Do not claim any of those provider integrations are verified
end-to-end until their smoke scripts exist and have actually been run
against real credentials.
