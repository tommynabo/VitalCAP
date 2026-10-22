import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { InstantlyInboxProvider } from "@/infrastructure/providers/instantly/inbox-provider";
import { getInstantlyInboxCampaignDiscoveryCounts, listConfiguredInstantlyCampaigns } from "@/infrastructure/neon/repositories/instantly-inbox-reconciliation";
import { getDb } from "@/infrastructure/neon/db";
import { runInstantlyInboxReconcileTick } from "@/infrastructure/jobs/runners/instantly-inbox-reconcile-runner";
import { getDeliveryEnv } from "@/lib/config/env";
import { requireWorkspaceOwner, UnauthorizedError } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const reconcileSchema = z.object({
  lookbackHours: z.number().int().min(1).max(168).default(72),
  maxMessages: z.number().int().min(1).max(100).default(100),
}).strict();

const migration0021Filename = "0021_instantly_inbox_reconcile.sql";
const migration0021Hash = "761f461eff8ea2bdec46fdd1f7c2699a2b26117d540f226b84ebc60e6d1404d0";

function normalizeSqlDefault(value: string | null): string | null {
  return value?.trim().replace(/^\((.*)\)$/, "$1") ?? null;
}

async function inspectMigration0021() {
  const db = getDb();
  const relations = await db.execute(sql`
    SELECT
      to_regclass('public.instantly_inbox_reconcile_state')::text AS reconcile_table,
      to_regclass('public.vitalcap_migrations')::text AS migration_ledger
  `);
  const reconcileTableExists = Boolean(relations.rows[0]?.reconcile_table);
  const migrationLedgerExists = Boolean(relations.rows[0]?.migration_ledger);
  const columns = reconcileTableExists
    ? (await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'instantly_inbox_reconcile_state'
      ORDER BY ordinal_position
    `)).rows as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      ordinal_position: number;
    }>
    : [];
  const primaryKeyColumns = reconcileTableExists
    ? (await db.execute(sql`
      SELECT key_column.column_name
      FROM information_schema.table_constraints AS constraint_row
      JOIN information_schema.key_column_usage AS key_column
        USING (constraint_catalog, constraint_schema, constraint_name, table_schema, table_name)
      WHERE constraint_row.constraint_type = 'PRIMARY KEY'
        AND constraint_row.table_schema = 'public'
        AND constraint_row.table_name = 'instantly_inbox_reconcile_state'
      ORDER BY key_column.ordinal_position
    `)).rows.map((row) => row.column_name as string)
    : [];
  const expected = [
    { column_name: "provider_campaign_id", data_type: "text", is_nullable: "NO", column_default: null },
    { column_name: "checkpoint_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    { column_name: "window_started_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    { column_name: "next_starting_after", data_type: "text", is_nullable: "YES", column_default: null },
    { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
  ];
  const tableSchemaMatches = columns.length === expected.length && expected.every((column, index) => {
    const actual = columns[index];
    return actual?.column_name === column.column_name
      && actual.data_type === column.data_type
      && actual.is_nullable === column.is_nullable
        && normalizeSqlDefault(actual.column_default) === column.column_default;
  });
  const primaryKeyValid = primaryKeyColumns.length === 1 && primaryKeyColumns[0] === "provider_campaign_id";
      const updatedAtDefaultValid = normalizeSqlDefault(columns.find((column) => column.column_name === "updated_at")?.column_default ?? null) === "now()";
  const ledgerColumns = migrationLedgerExists
    ? (await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vitalcap_migrations'
    `)).rows.map((row) => row.column_name as string)
    : [];
  const ledgerRows = migrationLedgerExists
    ? (await db.execute(sql`
      SELECT filename, hash
      FROM vitalcap_migrations
      WHERE filename = ${migration0021Filename}
      LIMIT 1
    `)).rows as Array<{ filename: string; hash: string }>
    : [];
  const ledgerRow = ledgerRows[0] ?? null;

  return {
    reconcileTableExists,
    tableSchemaMatches,
    primaryKeyValid,
    updatedAtDefaultValid,
    columns,
    primaryKeyColumns,
    migrationLedgerExists,
    migrationLedgerRecorded: Boolean(ledgerRow),
    migrationLedgerHashMatches: ledgerRow?.hash === migration0021Hash,
    migrationLedgerIdColumnPresent: ledgerColumns.includes("id"),
    repository0021Hash: migration0021Hash,
  };
}

export async function GET() {
  try {
    const context = await requireWorkspaceOwner();
    const env = getDeliveryEnv();
    if (env.EMAIL_DELIVERY_PROVIDER !== "instantly" || !env.INSTANTLY_API_KEY) {
      return NextResponse.json({ error: "Instantly inbox reconciliation is not configured." }, { status: 503 });
    }

    const targets = await listConfiguredInstantlyCampaigns(context.workspaceId);
    const counts = await getInstantlyInboxCampaignDiscoveryCounts(context.workspaceId, env.INSTANTLY_CAMPAIGN_ID);
    const provider = new InstantlyInboxProvider(env.INSTANTLY_API_KEY);
    const minTimestampCreated = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
    const unfiltered = await provider.listReceivedEmails({
      minTimestampCreated,
      limit: 100,
      startingAfter: null,
    });
    const targetProviderIds = [...new Set(targets.map((target) => target.providerCampaignId))];
    const filteredPages = await Promise.all(targetProviderIds.map((campaignId) => provider.listReceivedEmails({
      campaignId,
      minTimestampCreated,
      limit: 100,
      startingAfter: null,
    })));
    const targetIds = new Set(targetProviderIds);
    const association = { configuredTargetCampaign: 0, differentCampaign: 0, nullCampaignId: 0 };
    const workspaceIds = new Set<string>();
    for (const email of unfiltered.items) {
      const campaignId = typeof email.campaign_id === "string" ? email.campaign_id : null;
      if (!campaignId) association.nullCampaignId++;
      else if (targetIds.has(campaignId)) association.configuredTargetCampaign++;
      else association.differentCampaign++;
      if (typeof email.organization_id === "string" && email.organization_id) workspaceIds.add(email.organization_id);
    }

    const currentWorkspaceId = await provider.getCurrentWorkspaceId();
    const instantlyApiWorkspaceMatch = workspaceIds.size === 0 ? "unknown"
      : workspaceIds.size === 1 && workspaceIds.has(currentWorkspaceId) ? "yes" : "no";
    const migrationRows = await getDb().execute(sql`
      SELECT to_regclass('public.instantly_inbox_reconcile_state')::text AS table_name
    `);
    const migration0021Applied = Boolean(migrationRows.rows[0]?.table_name);
    const migration0021 = await inspectMigration0021();

    return NextResponse.json({
      configuredCampaignCount: counts.configuredCampaignCount,
      mappingTableCampaignCount: counts.mappingTableCampaignCount,
      engineConfigCampaignCount: counts.engineConfigCampaignCount,
      importProviderCampaignCount: counts.importProviderCampaignCount,
      importRowsForTargetCampaign: counts.importRowsForTargetCampaign,
      envTargetCampaignConfigured: counts.envTargetCampaignConfigured,
      unfilteredReceived72h: unfiltered.items.length,
      unfilteredHasMore: Boolean(unfiltered.nextStartingAfter),
      filteredReceived72h: filteredPages.reduce((total, page) => total + page.items.length, 0),
      filteredCampaignsChecked: targetProviderIds.length,
      campaignAssociation: association,
      instantlyApiWorkspaceMatch,
      migration0021Applied,
      migration0021,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Instantly inbox diagnostics failed." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    await requireWorkspaceOwner();
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "record-0021-ledger-only") {
      return NextResponse.json({ error: "Invalid migration-ledger action." }, { status: 400 });
    }

    const before = await inspectMigration0021();
    if (!before.reconcileTableExists || !before.tableSchemaMatches || !before.primaryKeyValid || !before.updatedAtDefaultValid) {
      return NextResponse.json({
        error: "Production checkpoint table does not exactly match migration 0021; no ledger change was made.",
        migration0021: before,
      }, { status: 409 });
    }
    if (!before.migrationLedgerExists) {
      return NextResponse.json({ error: "Production migration ledger is missing; no ledger change was made." }, { status: 409 });
    }
    if (before.migrationLedgerRecorded && !before.migrationLedgerHashMatches) {
      return NextResponse.json({ error: "Production migration ledger hash does not match repository migration 0021." }, { status: 409 });
    }

    if (!before.migrationLedgerRecorded) {
      if (before.migrationLedgerIdColumnPresent) {
        await getDb().execute(sql`
          INSERT INTO vitalcap_migrations (id, filename, hash, applied_at)
          SELECT COALESCE(MAX(id), 0) + 1, ${migration0021Filename}, ${migration0021Hash}, now()
          FROM vitalcap_migrations
          WHERE NOT EXISTS (
            SELECT 1 FROM vitalcap_migrations WHERE filename = ${migration0021Filename}
          )
        `);
      } else {
        await getDb().execute(sql`
          INSERT INTO vitalcap_migrations (filename, hash, applied_at)
          SELECT ${migration0021Filename}, ${migration0021Hash}, now()
          WHERE NOT EXISTS (
            SELECT 1 FROM vitalcap_migrations WHERE filename = ${migration0021Filename}
          )
        `);
      }
    }

    const after = await inspectMigration0021();
    return NextResponse.json({
      migrationLedgerRecordedAfter: after.migrationLedgerRecorded,
      migrationLedgerHashMatches: after.migrationLedgerHashMatches,
      futureDbMigrate0021Safe: after.reconcileTableExists
        && after.tableSchemaMatches
        && after.primaryKeyValid
        && after.updatedAtDefaultValid
        && after.migrationLedgerRecorded
        && after.migrationLedgerHashMatches,
      migration0021: after,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Migration ledger reconciliation failed; no migration SQL was executed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireWorkspaceOwner();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const input = reconcileSchema.parse(body);
    const result = await runInstantlyInboxReconcileTick({
      workspaceId: context.workspaceId,
      initialLookbackHours: input.lookbackHours,
      maxMessagesPerRun: input.maxMessages,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid reconciliation request." }, { status: 400 });
    return NextResponse.json({ error: "Instantly inbox reconciliation failed." }, { status: 500 });
  }
}
