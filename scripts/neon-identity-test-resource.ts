import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const PRODUCTION_NEON_PROJECT_ID = "morning-dew-35696777";
const VERIFIED_TEST_RESOURCE = {
  projectId: "shiny-cake-82433983",
  branchId: "br-small-dew-b9aujn0g",
  endpointId: "ep-odd-firefly-b9x1w52c",
  endpointHost: "ep-odd-firefly-b9x1w52c.c-7.eu-central-1.aws.neon.tech",
  databaseName: "vitalcap_identity_itest",
  runtimeRoleName: "vitalcap_identity_itest_rw",
  migrationRoleName: "neondb_owner",
} as const;
const VERIFIED_ATTESTATION_VALUE = "prompt-2.21-verified-test-project";
type NeonHttpSql = ReturnType<typeof neon<false, false>>;

const envNames = {
  databaseUrl: "VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL",
  unpooledDatabaseUrl: "VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL_UNPOOLED",
  migrationDatabaseUrl: "VITALCAP_NEON_IDENTITY_TEST_MIGRATION_DATABASE_URL_UNPOOLED",
  projectId: "VITALCAP_NEON_IDENTITY_TEST_PROJECT_ID",
  branchId: "VITALCAP_NEON_IDENTITY_TEST_BRANCH_ID",
  endpointId: "VITALCAP_NEON_IDENTITY_TEST_ENDPOINT_ID",
  databaseName: "VITALCAP_NEON_IDENTITY_TEST_DATABASE_NAME",
  roleName: "VITALCAP_NEON_IDENTITY_TEST_ROLE_NAME",
  apiKey: "VITALCAP_NEON_IDENTITY_TEST_NEON_API_KEY",
  attestation: "VITALCAP_NEON_IDENTITY_TEST_ATTESTATION",
} as const;

interface TestResourceConfig {
  databaseUrl: string;
  unpooledDatabaseUrl: string;
  migrationDatabaseUrl: string;
  projectId: string;
  branchId: string;
  endpointId: string;
  databaseName: string;
  roleName: string;
  apiKey?: string;
  attestation?: string;
}

interface ParsedConnection {
  url: URL;
  host: string;
  databaseName: string;
  roleName: string;
  password: string;
  sslMode: string;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`Required isolated Neon test setting is missing: ${name}.`);
  return value;
}

function configureSafeTestEnvironment(databaseUrl?: string): void {
  for (const name of Object.keys(process.env)) {
    if (
      name.startsWith("Vitalcap_")
      || name.startsWith("VITALCAP_NEON_IDENTITY_TEST_")
      || name.startsWith("SUPABASE_")
      || name.startsWith("NEXT_PUBLIC_SUPABASE_")
      || /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET)$/i.test(name)
    ) {
      delete process.env[name];
    }
  }

  for (const name of [
    "DATABASE_URL", "DATABASE_URL_UNPOOLED", "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER",
    "PGDATABASE", "PGPASSWORD", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "NEON_API_KEY",
    "APIFY_API_TOKEN", "SERPER_API_KEY", "MAPS_PROVIDER_API_KEY", "SERP_PROVIDER_API_KEY",
    "MILLION_VERIFIER", "INSTANTLY_API_KEY", "EMAIL_VERIFICATION_PROVIDER_API_KEY",
    "SMS_PROVIDER_API_KEY", "LLM_PROVIDER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY", "CRON_SECRET",
  ]) {
    delete process.env[name];
  }

  process.env.VERCEL = "1";
  process.env.APP_ENV = "test";
  process.env.DEV_SEED_MODE = "false";
  process.env.DEFAULT_DELIVERY_MODE = "dry_run";
  process.env.MAPS_PROVIDER = "mock";
  process.env.SERP_PROVIDER = "disabled";
  process.env.EMAIL_VERIFICATION_PROVIDER = "disabled";
  process.env.EMAIL_DELIVERY_PROVIDER = "disabled";
  process.env.LLM_PROVIDER = "disabled";
  process.env.SMS_PROVIDER = "disabled";
  process.env.VITALCAP_B2B_EMAIL_POLICY_APPROVED = "false";

  if (databaseUrl) process.env.Vitalcap_DATABASE_URL = databaseUrl;
}

function parseConnection(connectionString: string, label: string, allowMissingPassword = false): ParsedConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL connection URL.`);
  }

  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol)) {
    throw new Error(`${label} must use the PostgreSQL protocol.`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const roleName = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase() ?? "";
  if (!url.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new Error(`${label} must point to a Neon endpoint.`);
  }
  if (!databaseName || !roleName || (!password && !allowMissingPassword)) {
    throw new Error(`${label} must identify a dedicated database role, database, and password.`);
  }
  if (!["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error(`${label} must require TLS with sslmode=require or stronger.`);
  }

  return { url, host: url.hostname.toLowerCase(), databaseName, roleName, password, sslMode };
}

export interface VerifiedTestResourceAttestation {
  databaseUrl: string;
  unpooledDatabaseUrl: string;
  migrationDatabaseUrl: string;
  projectId: string;
  branchId: string;
  endpointId: string;
  databaseName: string;
  roleName: string;
}

export function assertVerifiedTestResourceAttestation(config: VerifiedTestResourceAttestation): void {
  if (
    config.projectId !== VERIFIED_TEST_RESOURCE.projectId
    || config.branchId !== VERIFIED_TEST_RESOURCE.branchId
    || config.endpointId !== VERIFIED_TEST_RESOURCE.endpointId
    || config.databaseName !== VERIFIED_TEST_RESOURCE.databaseName
    || config.roleName !== VERIFIED_TEST_RESOURCE.runtimeRoleName
  ) {
    throw new Error("Test resource metadata does not match the Prompt 2.21 allowlist.");
  }

  const runtime = parseConnection(config.databaseUrl, envNames.databaseUrl, true);
  const unpooled = parseConnection(config.unpooledDatabaseUrl, envNames.unpooledDatabaseUrl, true);
  const migration = parseConnection(config.migrationDatabaseUrl, envNames.migrationDatabaseUrl, true);
  for (const connection of [runtime, unpooled]) {
    if (
      connection.host !== VERIFIED_TEST_RESOURCE.endpointHost
      || connection.databaseName !== VERIFIED_TEST_RESOURCE.databaseName
      || connection.roleName !== VERIFIED_TEST_RESOURCE.runtimeRoleName
    ) {
      throw new Error("Runtime connection does not match the allowlisted test endpoint, database, and role.");
    }
  }
  if (
    migration.host !== VERIFIED_TEST_RESOURCE.endpointHost
    || migration.databaseName !== VERIFIED_TEST_RESOURCE.databaseName
    || migration.roleName !== VERIFIED_TEST_RESOURCE.migrationRoleName
  ) {
    throw new Error("Migration connection does not match the allowlisted test endpoint, database, and owner role.");
  }
}

function canonicalEndpointHost(host: string): string {
  return host.toLowerCase().replace(/-pooler(?=\.|$)/, "");
}

async function neonApiGet(path: string, apiKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Neon read-only identity check failed (HTTP ${response.status}).`);
  return await response.json() as Record<string, unknown>;
}

async function verifyResourceIdentity(config: TestResourceConfig): Promise<{
  runtime: ParsedConnection;
  unpooled: ParsedConnection;
  migration: ParsedConnection;
}> {
  if (config.projectId === PRODUCTION_NEON_PROJECT_ID) {
    throw new Error("The Production Neon project is forbidden for this integration test.");
  }

  assertVerifiedTestResourceAttestation(config);
  const runtime = parseConnection(config.databaseUrl, envNames.databaseUrl);
  const unpooled = parseConnection(config.unpooledDatabaseUrl, envNames.unpooledDatabaseUrl);
  const migration = parseConnection(config.migrationDatabaseUrl, envNames.migrationDatabaseUrl);
  for (const connection of [runtime, unpooled]) {
    if (connection.databaseName !== config.databaseName || connection.roleName !== config.roleName) {
      throw new Error("Test connection database or role does not match the approved test resource identity.");
    }
    if (connection.url.href.includes(PRODUCTION_NEON_PROJECT_ID)) {
      throw new Error("A Production Neon project identifier was found in a test connection URL.");
    }
  }
  if (unpooled.host.includes("-pooler.")) {
    throw new Error("The migration connection must use the Neon unpooled endpoint.");
  }

  if (!config.apiKey) {
    if (config.attestation !== VERIFIED_ATTESTATION_VALUE) {
      throw new Error("A read-only Neon API key or the explicit verified test-resource attestation is required.");
    }
    return { runtime, unpooled, migration };
  }

  const projectPath = `/projects/${encodeURIComponent(config.projectId)}`;
  const [projectResponse, branchResponse, endpointResponse] = await Promise.all([
    neonApiGet(projectPath, config.apiKey),
    neonApiGet(`${projectPath}/branches`, config.apiKey),
    neonApiGet(`${projectPath}/endpoints`, config.apiKey),
  ]);
  const project = (projectResponse.project ?? projectResponse) as Record<string, unknown>;
  const branches = branchResponse.branches as Array<Record<string, unknown>> | undefined;
  const endpoints = endpointResponse.endpoints as Array<Record<string, unknown>> | undefined;
  const branch = branches?.find((item) => item.id === config.branchId);
  const endpoint = endpoints?.find((item) => item.id === config.endpointId);

  if (project.id !== config.projectId) throw new Error("Neon API project ID does not match the approved test project.");
  if (!branch || branch.project_id !== config.projectId || branch.parent_id !== null) {
    throw new Error("The approved test branch is missing, belongs to another project, or has a parent branch.");
  }
  if (branch.init_source === "parent-data") {
    throw new Error("A branch initialized from parent data is forbidden for this integration test.");
  }
  if (
    !endpoint
    || endpoint.project_id !== config.projectId
    || endpoint.branch_id !== config.branchId
    || endpoint.type !== "read_write"
    || typeof endpoint.host !== "string"
  ) {
    throw new Error("Neon API endpoint does not match the approved test project and root branch.");
  }

  const apiHost = canonicalEndpointHost(endpoint.host);
  if ([runtime, unpooled, migration].some((connection) => canonicalEndpointHost(connection.host) !== apiHost)) {
    throw new Error("A test connection host does not map to the approved Neon endpoint.");
  }

  return { runtime, unpooled, migration };
}

function psqlEnvironment(connection: ParsedConnection): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "test",
    PGHOST: connection.host,
    PGPORT: connection.url.port || "5432",
    PGDATABASE: connection.databaseName,
    PGUSER: connection.roleName,
    PGPASSWORD: connection.password,
    PGSSLMODE: connection.sslMode,
    PGTARGETSESSIONATTRS: "read-write",
    PGAPPNAME: "vitalcap-neon-identity-test-migrations",
  };
}

async function applyVersionedMigrations(
  migrationSql: NeonHttpSql,
  unpooled: ParsedConnection,
): Promise<void> {
  const migrationDirectory = join(process.cwd(), "drizzle");
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = await Promise.all(files.map(async (filename) => {
    const contents = await readFile(join(migrationDirectory, filename), "utf8");
    return { filename, contents, hash: createHash("sha256").update(contents).digest("hex") };
  }));

  const stateRows = await migrationSql`
    SELECT to_regclass('public.vitalcap_neon_identity_test_migrations') IS NOT NULL AS ledger_exists,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_table_count
  ` as Array<Record<string, unknown>>;
  const state = stateRows[0];
  const ledgerExists = state?.ledger_exists === true;
  const publicTableCount = Number(state?.public_table_count ?? 0);
  if (!ledgerExists && publicTableCount !== 0) {
    throw new Error("The approved test database is not empty; migrations were not applied.");
  }

  if (!ledgerExists) {
    await migrationSql`
      CREATE TABLE public.vitalcap_neon_identity_test_migrations (
        filename text PRIMARY KEY,
        hash text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }

  const appliedRows = await migrationSql`
    SELECT filename, hash
    FROM public.vitalcap_neon_identity_test_migrations
    ORDER BY filename
  ` as Array<{ filename: string; hash: string }>;

  if (appliedRows.length > 0) {
    const applied = new Map(appliedRows.map((row) => [row.filename, row.hash]));
    const allMatch = applied.size === migrations.length
      && migrations.every((migration) => applied.get(migration.filename) === migration.hash);
    if (!allMatch) throw new Error("Test migration ledger is incomplete or differs from the checked-in migrations; refusing to continue.");
    return;
  }

  if (ledgerExists && publicTableCount !== 1) {
    throw new Error("The test migration ledger is empty but other public tables exist; refusing to apply migrations.");
  }

  for (const migration of migrations) {
    try {
      execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", join(migrationDirectory, migration.filename)], {
        cwd: process.cwd(),
        env: psqlEnvironment(unpooled),
        stdio: "ignore",
      });
    } catch {
      throw new Error(`Applying isolated test migration ${migration.filename} failed; no other database was targeted.`);
    }
    await migrationSql`
      INSERT INTO public.vitalcap_neon_identity_test_migrations (filename, hash)
      VALUES (${migration.filename}, ${migration.hash})
    `;
  }
}

async function grantRuntimePrivileges(migrationSql: NeonHttpSql): Promise<void> {
  await migrationSql`GRANT USAGE ON SCHEMA public TO vitalcap_identity_itest_rw`;
  await migrationSql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vitalcap_identity_itest_rw`;
  await migrationSql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vitalcap_identity_itest_rw`;
  await migrationSql`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vitalcap_identity_itest_rw`;
  await migrationSql`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vitalcap_identity_itest_rw`;
}

export async function initializeNeonIdentityTestResource(): Promise<boolean> {
  const databaseUrl = optionalEnv(envNames.databaseUrl);
  if (!databaseUrl) {
    configureSafeTestEnvironment();
    return false;
  }

  const config: TestResourceConfig = {
    databaseUrl,
    unpooledDatabaseUrl: requiredEnv(envNames.unpooledDatabaseUrl),
    migrationDatabaseUrl: requiredEnv(envNames.migrationDatabaseUrl),
    projectId: requiredEnv(envNames.projectId),
    branchId: requiredEnv(envNames.branchId),
    endpointId: requiredEnv(envNames.endpointId),
    databaseName: requiredEnv(envNames.databaseName),
    roleName: requiredEnv(envNames.roleName),
    apiKey: optionalEnv(envNames.apiKey),
    attestation: optionalEnv(envNames.attestation),
  };

  configureSafeTestEnvironment();
  process.env.Vitalcap_DATABASE_URL = config.databaseUrl;
  process.env.Vitalcap_DATABASE_URL_UNPOOLED = config.unpooledDatabaseUrl;
  const { getDatabaseEnv, resetServerEnvCacheForTests } = await import("../src/lib/config/env");
  resetServerEnvCacheForTests();
  const resolvedDatabaseEnv = getDatabaseEnv();
  if (
    process.env.VERCEL !== "1"
    || resolvedDatabaseEnv.DATABASE_URL !== config.databaseUrl
    || resolvedDatabaseEnv.DATABASE_URL_UNPOOLED !== config.unpooledDatabaseUrl
  ) {
    throw new Error("Effective database resolution did not select the verified test-only Neon URL.");
  }

  const { runtime, unpooled, migration } = await verifyResourceIdentity(config);
  const runtimeSql = neon(config.databaseUrl);
  const migrationSql = neon(config.migrationDatabaseUrl);
  const runtimeIdentityRows = await runtimeSql`
    SELECT current_database() AS database_name, current_user AS role_name,
      role.rolsuper, role.rolcreatedb, role.rolcreaterole,
      role.rolreplication, role.rolbypassrls,
      EXISTS (
        SELECT 1
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        WHERE membership.member = role.oid AND granted_role.rolname = 'neon_superuser'
      ) AS neon_superuser_member,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
    FROM pg_roles AS role
    WHERE role.rolname = current_user
  ` as Array<Record<string, unknown>>;
  const runtimeIdentity = runtimeIdentityRows[0];
  if (
    runtimeIdentity?.database_name !== config.databaseName
    || runtimeIdentity?.role_name !== config.roleName
    || runtimeIdentity?.rolsuper !== false
    || runtimeIdentity?.rolcreatedb !== false
    || runtimeIdentity?.rolcreaterole !== false
    || runtimeIdentity?.rolreplication !== false
    || runtimeIdentity?.rolbypassrls !== false
    || runtimeIdentity?.neon_superuser_member !== false
    || runtimeIdentity?.can_create_in_public !== false
  ) {
    throw new Error("Runtime SQL identity or privileges do not match the restricted test role.");
  }

  const migrationIdentityRows = await migrationSql`
    SELECT current_database() AS database_name, current_user AS role_name,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public
  ` as Array<Record<string, unknown>>;
  const migrationIdentity = migrationIdentityRows[0];
  if (
    migrationIdentity?.database_name !== config.databaseName
    || migrationIdentity?.role_name !== migration.roleName
    || migrationIdentity?.can_create_in_public !== true
  ) {
    throw new Error("Connected database identity does not match the approved Neon test resource.");
  }

  await applyVersionedMigrations(migrationSql, migration);
  await grantRuntimePrivileges(migrationSql);
  const remainingRowsResult = await runtimeSql`
    SELECT
      (SELECT count(*)::int FROM workspaces) AS workspaces,
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM contacts) AS contacts,
      (SELECT count(*)::int FROM campaigns) AS campaigns
  ` as Array<Record<string, unknown>>;
  const remainingRows = remainingRowsResult[0];
  if (Object.values(remainingRows ?? {}).some((count) => Number(count) !== 0)) {
    throw new Error("The isolated test database contains application rows; refusing to run fixtures.");
  }

  return true;
}