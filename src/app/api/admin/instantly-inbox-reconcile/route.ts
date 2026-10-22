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
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Instantly inbox diagnostics failed." }, { status: 500 });
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
