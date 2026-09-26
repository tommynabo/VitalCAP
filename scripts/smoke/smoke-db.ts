import { neon } from "@neondatabase/serverless";

const neonPrefixes = ["Vitalcap"];
const requiredTables = [
  "workspaces",
  "workspace_members",
  "accounts",
  "account_sources",
  "contacts",
  "contact_points",
  "campaigns",
  "campaign_memberships",
  "discovery_jobs",
  "processing_jobs",
  "outreach_queue",
  "dead_letter_jobs",
  "provider_runs",
  "conversations",
  "account_merge_records",
  "offers",
  "raw_candidates",
  "search_seeds",
  "search_seed_runs",
  "outreach_events",
  "setter_drafts",
  "setter_feedback",
  "meetings",
  "suppression_entries",
  "sending_domains",
  "mailboxes",
  "warm_followup_queue",
  "rebalance_decisions",
  "audit_log",
  "conversation_messages",
  "cron_runs",
];

function resolveDatabaseUrl(name: "DATABASE_URL"): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  return neonPrefixes.map((prefix) => process.env[`${prefix}_${name}`]?.trim()).find(Boolean);
}

const databaseUrl = resolveDatabaseUrl("DATABASE_URL");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for smoke:db.");
}

const db = neon(databaseUrl);
const one = await db`SELECT 1 AS value`;
if (Number((one[0] as { value: number } | undefined)?.value) !== 1) {
  throw new Error("SELECT 1: FAIL");
}

const migrationRows = await db`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vitalcap_migrations'
`;
const migrationColumnNames = new Set(migrationRows.map((row) => (row as { column_name: string }).column_name));
if (!migrationColumnNames.has("filename") || !migrationColumnNames.has("hash") || !migrationColumnNames.has("applied_at")) {
  throw new Error("Migration tracking: FAIL");
}
const requiredMigrationFiles = [
  "0000_base_schema.sql",
  "0001_phase8a_job_queue_hardening.sql",
  "0002_phase8c_maps_idempotency.sql",
  "0003_phase8f_apify_async.sql",
  "0004_phase8g_autopilot_control.sql",
  "0005_phase8g1_stabilization.sql",
];
const appliedMigrationRows = await db`
  SELECT filename FROM vitalcap_migrations WHERE filename = ANY(${requiredMigrationFiles})
`;
const appliedMigrationFiles = new Set(appliedMigrationRows.map((row) => String((row as { filename: string }).filename)));
if (requiredMigrationFiles.some((filename) => !appliedMigrationFiles.has(filename))) {
  throw new Error(`Migration versions: FAIL (missing ${requiredMigrationFiles.filter((filename) => !appliedMigrationFiles.has(filename)).join(", ")})`);
}

const rawAndSourceIndexes = await db`
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN ('uq_raw_candidates_campaign_engine_external', 'uq_account_sources_external')
`;
const expectedReplayIndexes = new Set(rawAndSourceIndexes.map((row) => (row as { indexname: string }).indexname));
if (!expectedReplayIndexes.has("uq_raw_candidates_campaign_engine_external") || !expectedReplayIndexes.has("uq_account_sources_external")) {
  throw new Error("Replay idempotency indexes: FAIL");
}
const tables = await db`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = ANY(${requiredTables})
`;
const tableNames = new Set(tables.map((row) => String((row as { table_name: string }).table_name)));
const missingTables = requiredTables.filter((table) => !tableNames.has(table));

const queueColumns = await db`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('discovery_jobs', 'processing_jobs', 'outreach_queue')
    AND column_name IN ('next_attempt_at', 'idempotency_key', 'locked_at', 'locked_by')
`;
const queueColumnKeys = new Set(
  queueColumns.map((row) => {
    const value = row as { table_name: string; column_name: string };
    return `${value.table_name}.${value.column_name}`;
  }),
);
const expectedQueueColumns = ["discovery_jobs", "processing_jobs", "outreach_queue"].flatMap((table) =>
  ["next_attempt_at", "idempotency_key", "locked_at", "locked_by"].map((column) => `${table}.${column}`),
);

const indexes = await db`
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'uq_discovery_jobs_idempotency_inflight',
      'uq_processing_jobs_idempotency_inflight',
      'uq_outreach_queue_idempotency_inflight',
      'uq_dead_letter_jobs_source_job'
    )
`;
const indexNames = new Set(indexes.map((row) => String((row as { indexname: string }).indexname)));
const expectedIndexes = [
  "uq_discovery_jobs_idempotency_inflight",
  "uq_processing_jobs_idempotency_inflight",
  "uq_outreach_queue_idempotency_inflight",
  "uq_dead_letter_jobs_source_job",
];

const providerRunColumns = await db`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'provider_runs'
    AND column_name = ANY(${["request_key", "actor_id", "seed_id", "ingested_at", "error"]})
`;
const providerRunColumnNames = new Set(providerRunColumns.map((row) => String((row as { column_name: string }).column_name)));
const requiredProviderRunColumns = ["request_key", "actor_id", "seed_id", "ingested_at", "error"];

const autopilotColumns = await db`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'autopilot_settings'
    AND column_name = ANY(${["workspace_id", "enabled", "emergency_stopped", "global_daily_target", "target_metric", "timezone"]})
`;
const autopilotColumnNames = new Set(autopilotColumns.map((row) => String((row as { column_name: string }).column_name)));
const requiredAutopilotColumns = ["workspace_id", "enabled", "emergency_stopped", "global_daily_target", "target_metric", "timezone"];
const targetMetricConstraint = await db`
  SELECT 1
  FROM pg_constraint
  WHERE conrelid = 'autopilot_settings'::regclass
    AND pg_get_constraintdef(oid) LIKE '%target_metric%'
    AND pg_get_constraintdef(oid) LIKE '%qualified%'
    AND pg_get_constraintdef(oid) LIKE '%analyzed_qualified%'
    AND pg_get_constraintdef(oid) LIKE '%outreach_ready%'
`;
const providerRunIndexes = await db`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'uq_provider_runs_request_key'
`;

await db.transaction([db`SELECT 1`]);

if (missingTables.length > 0) {
  throw new Error(`Core tables: FAIL (missing ${missingTables.length})`);
}
if (expectedQueueColumns.some((column) => !queueColumnKeys.has(column))) {
  throw new Error("Queue lease columns: FAIL");
}
if (expectedIndexes.some((index) => !indexNames.has(index))) {
  throw new Error("Idempotency indexes: FAIL");
}
if (requiredProviderRunColumns.some((column) => !providerRunColumnNames.has(column))) {
  throw new Error("Provider-run async columns: FAIL (Phase 8F migration missing)");
}
if (!providerRunIndexes.length) throw new Error("Provider-run request-key index: FAIL (Phase 8F migration missing)");
if (requiredAutopilotColumns.some((column) => !autopilotColumnNames.has(column)) || !targetMetricConstraint.length) {
  throw new Error("Autopilot control columns/constraint: FAIL (Phase 8G/8G.1 migration missing)");
}

console.log("Neon connection: PASS");
console.log("Core tables: PASS");
console.log("Queue tables: PASS");
console.log("Queue lease columns: PASS");
console.log("Idempotency indexes: PASS");
console.log("Replay idempotency indexes: PASS");
console.log("Provider-run async columns and request-key index: PASS");
console.log("Autopilot settings and target metric constraint: PASS");
console.log("Migration tracking: PASS");
console.log("Migrations 0000-0005: PASS");
console.log("Transaction round-trip: PASS");