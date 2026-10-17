import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/infrastructure/neon/db";
import { listCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { autopilotSettings } from "@/infrastructure/neon/schema/autopilot";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";
import { getApifyRecoverySnapshot } from "@/infrastructure/neon/repositories/provider-runs";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { resolveNeonVar } from "@/lib/config/env-utils";
import { getApifyAllocationHealth } from "@/services/discovery/provider-health";

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

function sanitizeApifyFailureMessage(message: string | null): string | null {
  if (!message) return null;
  const bodyStart = message.indexOf("{");
  if (bodyStart >= 0) {
    const prefix = message.slice(0, bodyStart).trim();
    try {
      const body: unknown = JSON.parse(message.slice(bodyStart));
      const errorValue = body && typeof body === "object" && "error" in body
        ? body.error
        : null;
      const errorBody = errorValue && typeof errorValue === "object"
        ? errorValue as Record<string, unknown>
        : null;
      const errorType = typeof errorBody?.type === "string" ? errorBody.type : null;
      const errorDetail = typeof errorBody?.message === "string" ? errorBody.message : null;
      message = [prefix, errorType, errorDetail].filter(Boolean).join(" ");
    } catch {
      message = prefix || "Apify provider returned an error.";
    }
  }
  return message
    .replace(/\bapify_api_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}&]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|key|secret|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:external[_-]?)?(?:actor|dataset|run|request)[_-]?id)\s*[:=]\s*["']?[^"',\s}&]+/gi, "$1=[REDACTED]")
    .replace(/\b((?:query|search[_-]?term)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 300) || null;
}

function formatDiagnosticDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    const [campaignRows, [settings], apifyRecovery] = await Promise.all([
      listCampaigns(workspaceId),
      db.select({
        enabled: autopilotSettings.enabled,
        systemPaused: autopilotSettings.systemPaused,
        emergencyStopped: autopilotSettings.emergencyStopped,
        target: autopilotSettings.globalDailyTarget,
      }).from(autopilotSettings).where(eq(autopilotSettings.workspaceId, workspaceId)).limit(1),
      getApifyRecoverySnapshot(workspaceId),
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
      apify: {
        allocationHealth: getApifyAllocationHealth(apifyRecovery),
        recoveryProbeEligible: apifyRecovery.recoveryProbeEligible,
        recoveryProbeInFlight: apifyRecovery.recoveryProbeInFlight,
        nextRecoveryAttemptAt: formatDiagnosticDate(apifyRecovery.nextRecoveryAttemptAt),
        latestFailureKind: apifyRecovery.latestFailureKind,
        latestFailureAt: formatDiagnosticDate(apifyRecovery.latestFailureAt),
        latestFailureMessage: sanitizeApifyFailureMessage(apifyRecovery.latestFailureMessage),
        latestSuccessAt: formatDiagnosticDate(apifyRecovery.latestSuccessAt),
      },
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