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

console.log("Neon connection: PASS");
console.log("Core tables: PASS");
console.log("Queue tables: PASS");
console.log("Queue lease columns: PASS");
console.log("Idempotency indexes: PASS");
console.log("Replay idempotency indexes: PASS");
console.log("Migration tracking: PASS");
console.log("Transaction round-trip: PASS");