import type { EngineTargetState } from "@/domain/autopilot/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const ENGINE_LABELS: Record<EngineTargetState["engineType"], string> = {
  maps_fast: "Maps Fast",
  maps_deep: "Maps Deep",
  google_serp: "Google SERP",
  linkedin_owner: "LinkedIn Owner",
  hybrid_fill: "Hybrid Fill",
};

const HEALTH_VARIANT: Record<EngineTargetState["providerHealth"], "success" | "warning" | "danger" | "neutral"> = {
  untested: "neutral",
  healthy: "success",
  degraded: "warning",
  paused: "danger",
  unknown: "neutral",
};

function formatTimestamp(value: string | null, timeZone: string): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
}

export function EngineCard({ engine, timeZone = "Europe/Madrid" }: { engine: EngineTargetState; timeZone?: string }) {
  const achieved = engine.targetAchievedToday ?? engine.readyToday;
  const progressPct = engine.softTarget > 0 ? Math.min(100, Math.round((achieved / engine.softTarget) * 100)) : 0;
  const providerConfigured = engine.providerConfigured !== false;
  const campaignActive = engine.campaignActive ?? engine.softTarget > 0;
  const autopilotEnabled = engine.autopilotEnabled ?? engine.softTarget > 0;
  const status = !providerConfigured ? "NOT CONFIGURED" : engine.providerHealth === "unknown" ? "UNTESTED" : engine.providerHealth.toUpperCase();
  const statusVariant = providerConfigured ? HEALTH_VARIANT[engine.providerHealth] : "danger";
  const queueDepth = engine.rawQueueDepth + engine.processingQueueDepth;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ENGINE_LABELS[engine.engineType]}</CardTitle>
        <Badge variant={statusVariant}>{status}</Badge>
      </CardHeader>
      <CardContent>
        {campaignActive && autopilotEnabled && !providerConfigured ? (
          <p className="mb-3 rounded border border-warning bg-warning/10 p-2 text-xs text-warning">
            Campaign is active and Autopilot is ON, but its provider is NOT CONFIGURED.
          </p>
        ) : null}
        <p className="text-xl font-semibold text-text">
          {achieved} <span className="text-sm font-normal text-text-muted">/ {engine.softTarget} qualified</span>
        </p>
        <Progress value={progressPct} className="mt-2" />
        <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-text-muted">Campaign</dt>
            <dd className="font-medium text-text">{campaignActive ? "ACTIVE" : "NO ACTIVE CAMPAIGN"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Autopilot</dt>
            <dd className="font-medium text-text">{autopilotEnabled ? "ON" : "OFF"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Provider configured</dt>
            <dd className="font-medium text-text">{providerConfigured ? "YES" : "NO"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Last run</dt>
            <dd className="font-medium text-text">{formatTimestamp(engine.lastRunAt, timeZone)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Raw today</dt>
            <dd className="font-medium text-text">{engine.rawToday ?? 0}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Accounts today</dt>
            <dd className="font-medium text-text">{engine.accountsToday ?? 0}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Qualified today</dt>
            <dd className="font-medium text-text">{engine.qualifiedToday ?? achieved}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Queue depth</dt>
            <dd className="font-medium text-text">{queueDepth}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-text-muted">Yield {Math.round(engine.currentYield * 100)}%</p>
        {engine.lastError ? <p className="mt-3 break-words border-t border-border pt-3 text-xs text-danger">Last error: {engine.lastError}</p> : null}
        {engine.nextPlannedAction ? (
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">{engine.nextPlannedAction}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
