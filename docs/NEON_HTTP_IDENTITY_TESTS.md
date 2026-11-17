# Neon HTTP Identity Integration Tests

The opt-in suite uses the real Neon HTTP driver, Drizzle repositories, canonical resolver, and scoped processing runner. It is not part of `npm test`, `next build`, or Production/Vercel test execution.

## Required Test Resource

Use only the independently verified Neon test project `shiny-cake-82433983`, root branch `br-small-dew-b9aujn0g`, and endpoint `ep-odd-firefly-b9x1w52c` at `ep-odd-firefly-b9x1w52c.c-7.eu-central-1.aws.neon.tech`. This fixed test attestation is not a general project override and cannot accept other project IDs, branches, endpoints, hosts, database names, or runtime roles. Production project `morning-dew-35696777` is forbidden.

Create database `vitalcap_identity_itest` owned by `neondb_owner`, and runtime role `vitalcap_identity_itest_rw` with only public-schema read/write privileges. The runtime role must not have superuser, database/role creation, or public-schema `CREATE` privileges. Use a separate unpooled owner connection for migrations; the runtime connection is never elevated. The harness checks the exact URL host/database/role allowlist, then confirms `current_database()` and `current_user` for both connections before applying migrations. It applies the checked-in `drizzle/*.sql` migrations using local `psql`, grants DML to the test role only in this test database's `public` schema, and checks that application tables contain no rows before fixtures. An interrupted or partial migration is a hard failure; do not point the harness at another database to recover it.

If no read-only Neon Management API credential is available, the explicit `prompt-2.21-verified-test-project` attestation is allowed only with the hard-coded test IDs and endpoint above. Regression tests reject a mismatched project, endpoint host, database, or runtime role.

Provide these values through a temporary shell environment or an approved secret manager. Do not commit them or place Production values here:

```text
VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL
VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL_UNPOOLED
VITALCAP_NEON_IDENTITY_TEST_MIGRATION_DATABASE_URL_UNPOOLED
VITALCAP_NEON_IDENTITY_TEST_PROJECT_ID
VITALCAP_NEON_IDENTITY_TEST_BRANCH_ID
VITALCAP_NEON_IDENTITY_TEST_ENDPOINT_ID
VITALCAP_NEON_IDENTITY_TEST_DATABASE_NAME=vitalcap_identity_itest
VITALCAP_NEON_IDENTITY_TEST_ROLE_NAME=vitalcap_identity_itest_rw
VITALCAP_NEON_IDENTITY_TEST_ATTESTATION=prompt-2.21-verified-test-project
```

The two `DATABASE_URL` values use the restricted runtime role. The migration URL uses `neondb_owner`. Keep all three URLs in an ignored, access-restricted local secret source; never place them in chat, tracked files, terminal output, or test reports. A read-only `VITALCAP_NEON_IDENTITY_TEST_NEON_API_KEY` may be used instead of the attestation, but is not required for this fixed resource.

Run only the dedicated command:

```sh
npm run test:neon-identity
```

For an audit run, set `NEON_IDENTITY_TEST_REPORT_RESULTS=true` to print per-scenario synthetic account IDs and isolation counts. The report never includes connection details or credentials.

Without `VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL`, the suite reports an explicit skip and does not consider `DATABASE_URL`, `Vitalcap_DATABASE_URL`, `.env` defaults, or other credentials. If the test URL is present but identity metadata is incomplete or mismatched, setup fails before querying the database. Test startup removes inherited provider/Supabase credentials and sets `VERCEL=1` with only the verified test URL in `Vitalcap_DATABASE_URL`, proving the effective Vercel precedence.

## Preview Isolation Proposal

No Vercel changes are applied by this repository harness. Before a Preview deployment is allowed:

1. Remove Production-backed `Vitalcap_*` Neon integration variables from Preview. Because `VERCEL=1` makes these variables authoritative, an ordinary `DATABASE_URL` override is insufficient. Remove both prefixed and ordinary database URLs from Preview if database access is not needed; otherwise configure both effective paths only with the verified test project and ensure the prefixed value is the test URL.
2. Do not attach a Neon Preview integration that branches from the Production project. Use the independent test project/root branch, or make Preview database writes fail closed.
3. Remove Preview targets for `INSTANTLY_API_KEY`, `APIFY_API_TOKEN`, `SERPER_API_KEY`, `MAPS_PROVIDER_API_KEY`, `SERP_PROVIDER_API_KEY`, `EMAIL_VERIFICATION_PROVIDER_API_KEY`, `SMS_PROVIDER_API_KEY`, live LLM keys, and any live email credentials. Set `DEFAULT_DELIVERY_MODE=dry_run`, `EMAIL_DELIVERY_PROVIDER=disabled`, `EMAIL_VERIFICATION_PROVIDER=disabled`, `MAPS_PROVIDER=mock`, `SERP_PROVIDER=disabled`, `LLM_PROVIDER=disabled`, and `VITALCAP_B2B_EMAIL_POLICY_APPROVED=false`.
4. Remove Production `SUPABASE_SERVICE_ROLE_KEY` and other privileged Supabase credentials from Preview. Any publishable Supabase URL/key must point to an approved test project, not be assumed isolated from its variable name.
5. Scope any remaining Preview-only values to the canonical-identity feature branch and keep Production targets/integrations unchanged. Verify the resolved database precedence and provider behavior again after configuration, before any push or deployment.

Production variables, Neon integrations, and campaigns must remain untouched. Project/resource provisioning and Vercel environment changes require separate approval.