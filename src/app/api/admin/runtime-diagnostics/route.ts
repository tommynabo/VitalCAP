import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/infrastructure/neon/db";
import { listCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { autopilotSettings } from "@/infrastructure/neon/schema/autopilot";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { resolveNeonVar } from "@/lib/config/env-utils";

export const dynamic = "force-dynamic";

function getDatabaseIdentity() {
  const connectionString = resolveNeonVar("DATABASE_URL");
  if (!connectionString) return { databaseHostMasked: null, databaseName: null };

  try {
    const databaseUrl = new URL(connectionString);
    const [hostLabel = "", ...hostSuffix] = databaseUrl.hostname.split(".");
    return {
      databaseHostMasked: hostSuffix.length > 0
        ? `${hostLabel.slice(0, 5)}***.${hostSuffix.join(".")}`
        : "***",
      databaseName: decodeURIComponent(databaseUrl.pathname.slice(1)) || null,
    };
  } catch {
    return { databaseHostMasked: "configured-unparseable", databaseName: null };
  }
}


export async function GET() {
  try {
    const user = await requireCurrentUser();
    const workspaceId = await getCurrentWorkspaceId();
    const role = await getWorkspaceRole(workspaceId, user.userId);
    if (role !== "admin" && role !== "owner") {
      return NextResponse.json({ error: "Workspace admin authorization required." }, { status: 403 });
    }

    const db = getDb();
    const [campaignRows, [settings]] = await Promise.all([
      listCampaigns(workspaceId),
      db.select({
        enabled: autopilotSettings.enabled,
        systemPaused: autopilotSettings.systemPaused,
        emergencyStopped: autopilotSettings.emergencyStopped,
        target: autopilotSettings.globalDailyTarget,
      }).from(autopilotSettings).where(eq(autopilotSettings.workspaceId, workspaceId)).limit(1),
    ]);

    return NextResponse.json({
      currentUserId: user.userId,
      workspaceId,
      appEnv: process.env.APP_ENV ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      devSeedMode: (process.env.DEV_SEED_MODE ?? "true").trim().toLowerCase() === "true",
      ...getDatabaseIdentity(),
      campaigns: campaignRows.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        autopilotEnabled: campaign.autopilotEnabled,
        engineType: campaign.engineType,
        dailySoftTarget: campaign.dailySoftTarget,
      })),
      autopilot: settings ? {
        enabled: settings.enabled,
        systemPaused: settings.systemPaused,
        emergencyStopped: settings.emergencyStopped,
        target: settings.target,
      } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    return NextResponse.json({ error: "Runtime diagnostics unavailable." }, { status: 500 });
  }
}