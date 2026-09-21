import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  seedCronLastRunAt,
  seedDbConnectivityOk,
  seedDeadLetterSamples,
  seedProviderRows,
  seedQueueHealth,
  seedWebhookLastEventAt,
  getSeedGlobalAutopilotState,
} from "@/lib/seed/dev-seed";
import { buildAdminDiagnostics } from "@/lib/observability/admin-diagnostics";

/**
 * Prompt 6 §6.3 — internal operations diagnostics. Deliberately lives
 * outside the `(dashboard)` route group (no `AppShell`, no sidebar) and is
 * not listed in `NAV_ITEMS`, so it is never reachable from the normal
 * salesperson-facing navigation. Intended for whoever operates the system,
 * not for day-to-day sales use.
 */
export default function AdminDiagnosticsPage() {
  const autopilotState = getSeedGlobalAutopilotState();
  const snapshot = buildAdminDiagnostics({
    queueHealth: seedQueueHealth,
    now: new Date(),
    providers: seedProviderRows,
    cronLastRunAt: seedCronLastRunAt,
    webhookLastEventAt: seedWebhookLastEventAt,
    dbConnectivityOk: seedDbConnectivityOk,
    currentTargetState: {
      dailyTarget: autopilotState.dailyTarget,
      readyToday: autopilotState.readyToday,
      systemHealth: autopilotState.systemHealth,
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8 font-sans text-text">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">System diagnostics</h1>
        <p className="text-sm text-text-muted">
          Internal operations view — not part of the salesperson navigation. Generated at {snapshot.generatedAt}.
        </p>
        <Badge variant={snapshot.overallHealthy ? "success" : "danger"} className="mt-2">
          {snapshot.overallHealthy ? "Overall: healthy" : "Overall: attention needed"}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Job queue health</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Pending" value={snapshot.queueHealth.pendingCount} />
          <Stat label="Processing" value={snapshot.queueHealth.processingCount} />
          <Stat label="Dead-lettered" value={snapshot.queueHealth.deadLetterCount} />
          <Stat label="Oldest pending age (min)" value={Math.round((snapshot.queueHealth.oldestPendingAgeMs ?? 0) / 60000)} />
          <Stat label="Stuck processing" value={snapshot.queueHealth.stuckProcessingCount} />
          <div>
            <p className="text-xs font-medium text-text-muted">Queue status</p>
            <Badge variant={snapshot.queueHealth.healthy ? "success" : "danger"} className="mt-1">
              {snapshot.queueHealth.healthy ? "healthy" : "unhealthy"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Provider health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.providers.map((provider) => (
            <div key={provider.name} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">{provider.name}</p>
                <p className="text-xs text-text-muted">{provider.detail}</p>
              </div>
              <Badge variant={provider.status === "connected" || provider.status === "healthy" ? "success" : "danger"}>
                {provider.status}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cron / webhooks / connectivity</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-text-muted">Cron last run</p>
            <p className="text-sm">{snapshot.cronLastRunAt ?? "never"}</p>
            <Badge variant={snapshot.cronStale ? "danger" : "success"} className="mt-1">
              {snapshot.cronStale ? "stale" : "fresh"}
            </Badge>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Webhook last event</p>
            <p className="text-sm">{snapshot.webhookLastEventAt ?? "never"}</p>
            <Badge variant={snapshot.webhookStale ? "warning" : "success"} className="mt-1">
              {snapshot.webhookStale ? "stale" : "fresh"}
            </Badge>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Database connectivity</p>
            <Badge variant={snapshot.dbConnectivityOk ? "success" : "danger"} className="mt-1">
              {snapshot.dbConnectivityOk ? "reachable" : "unreachable"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current target state</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <Stat label="Daily target" value={snapshot.currentTargetState.dailyTarget} />
          <Stat label="Ready today" value={snapshot.currentTargetState.readyToday} />
          <div>
            <p className="text-xs font-medium text-text-muted">System health</p>
            <Badge variant={snapshot.currentTargetState.systemHealth === "healthy" ? "success" : "warning"} className="mt-1">
              {snapshot.currentTargetState.systemHealth}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent dead-letter samples</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {seedDeadLetterSamples.map((sample) => (
            <div key={sample.id} className="rounded-md border border-border px-3 py-2 text-sm">
              <p className="font-medium">{sample.jobType}</p>
              <p className="text-xs text-text-muted">{sample.reason}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-muted">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
