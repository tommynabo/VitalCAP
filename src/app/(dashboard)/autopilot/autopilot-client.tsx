"use client";

import { useState } from "react";
import { AlertTriangle, Pause, Play } from "lucide-react";
import { EngineCard } from "@/components/dashboard/engine-card";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { RebalanceActivity } from "@/components/dashboard/rebalance-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { globalProgressPct, sumSoftTargets } from "@/lib/autopilot/targets";
import type { DeadLetterSample, ProviderRowStatus, QueueHealthSnapshot } from "@/lib/data/repository";
import type { AutopilotSettings, GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";

interface ProviderRow {
  name: string;
  status: ProviderRowStatus;
  detail: string;
}

export function AutopilotClient({
  state,
  settings,
  lastAutopilotCron,
  lastDiscoveryCron,
  deadLetterSamples,
  providerRows,
  queueHealth,
  rebalanceDecisions,
}: {
  state: GlobalAutopilotState;
  settings: AutopilotSettings;
  lastAutopilotCron: string | null;
  lastDiscoveryCron: string | null;
  deadLetterSamples: DeadLetterSample[];
  providerRows: ProviderRow[];
  queueHealth: QueueHealthSnapshot;
  rebalanceDecisions: RebalanceDecision[];
}) {
  const progressPct = globalProgressPct(state.dailyTarget, state.engines);
  const softTargetTotal = sumSoftTargets(state.engines);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveState = settings.emergencyStopped ? "emergency_stopped" : settings.enabled ? "running" : "paused";
  const [targetInput, setTargetInput] = useState(String(settings.globalDailyTarget));

  async function control(action: Record<string, unknown>) {
    setPendingAction(String(action.action));
    setError(null);
    try {
      const response = await fetch("/api/autopilot/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Autopilot control failed.");
      window.location.reload();
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "Autopilot control failed.");
    } finally {
      setPendingAction(null);
    }
  }

  const degradedProviders = providerRows.filter((p) => p.status === "degraded" || p.status === "paused");

  return (
    <div className="space-y-6">
      <Card className={effectiveState !== "running" ? "border-warning" : undefined}>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div>
            <p className="text-sm font-semibold text-text">
              Autopilot is {effectiveState === "running" ? "running" : effectiveState === "paused" ? "paused" : "emergency stopped"}
            </p>
            <p className="text-xs text-text-muted">
              {effectiveState === "running" ? `Targeting ${settings.globalDailyTarget} ready leads/day across ${state.engines.length} engines · system health ${state.systemHealth}` : effectiveState === "paused" ? "New discovery is paused; existing processing jobs may drain safely." : "Emergency stop blocks new discovery, processing claims, and outreach scheduling."}
            </p>
          </div>
          <div className="flex gap-2">
            {effectiveState === "running" ? (
              <Button variant="secondary" size="sm" disabled={pendingAction !== null} onClick={() => control({ action: "pause" })}>
                <Pause className="h-4 w-4" aria-hidden="true" />
                Pause
              </Button>
            ) : (
              <Button size="sm" disabled={pendingAction !== null || effectiveState === "emergency_stopped"} onClick={() => control({ action: "resume" })}>
                <Play className="h-4 w-4" aria-hidden="true" />
                Resume
              </Button>
            )}
            <Button variant="danger" size="sm" disabled={pendingAction !== null || effectiveState === "emergency_stopped"} onClick={() => { if (window.confirm("Emergency stop will prevent all new discovery and processing activity. Existing data is preserved.")) void control({ action: "emergency_stop" }); }}>
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Emergency stop
            </Button>
          </div>
          {effectiveState === "emergency_stopped" && <Button size="sm" disabled={pendingAction !== null} onClick={() => void control({ action: "clear_emergency_stop" })}>Clear emergency stop</Button>}
          {error && <p className="w-full text-xs text-danger">{error}</p>}
        </CardContent>
      </Card>

      <p className="text-xs text-text-muted">Last Autopilot cron: {lastAutopilotCron ? new Date(lastAutopilotCron).toLocaleString() : "N/A"} · Last discovery cron: {lastDiscoveryCron ? new Date(lastDiscoveryCron).toLocaleString() : "N/A"}</p>

      <Card>
        <CardHeader><CardTitle>Global daily target</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-text-muted">Ready leads/day<input className="mt-1 block w-28 rounded border border-border bg-surface px-2 py-1 text-text" type="number" min="1" max="250" value={targetInput} onChange={(event) => setTargetInput(event.target.value)} /></label>
          <Button size="sm" disabled={pendingAction !== null} onClick={() => void control({ action: "target_change", globalDailyTarget: Number(targetInput) })}>Save target</Button>
          <span className="text-xs text-text-muted">Recommended 25 · timezone {settings.timezone}</span>
          {softTargetTotal !== settings.globalDailyTarget && <span className="text-xs text-warning">Campaign soft targets total {softTargetTotal}; allocation is not changed automatically.</span>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Ready" value={`${state.readyToday}/${state.dailyTarget}`} emphasize />
        <KpiStat label="Progress" value={`${progressPct}%`} />
        <KpiStat label="Soft target total" value={String(softTargetTotal)} />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Ready buffer" value={state.readyBufferDays === null ? "N/A" : state.readyBufferDays.toFixed(1)} suffix={state.readyBufferDays === null ? undefined : "days"} />
        <KpiStat label="System health" value={state.systemHealth} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Target allocation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.engines.map((engine) => {
            const pct = engine.softTarget > 0 ? Math.min(100, Math.round((engine.readyToday / engine.softTarget) * 100)) : 0;
            return (
              <div key={engine.engineType}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-text">{engine.engineType.replace("_", " ")}</span>
                  <span className="text-text-muted">
                    {engine.readyToday}/{engine.softTarget} ready · {pct}%
                  </span>
                </div>
                <Progress value={pct} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Discovery engines</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {state.engines.map((engine) => (
            <EngineCard key={engine.engineType} engine={engine} />
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <RebalanceActivity decisions={rebalanceDecisions} />

        <Card>
          <CardHeader>
            <CardTitle>Queue health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex justify-between"><span className="text-text-muted">Pending</span><span className="font-medium text-text">{queueHealth.pendingCount}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Processing</span><span className="font-medium text-text">{queueHealth.processingCount}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Oldest pending</span><span className="font-medium text-text">{Math.round((queueHealth.oldestPendingAgeMs ?? 0) / 60000)} min</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Dead-letter</span><span className="font-medium text-text">{queueHealth.deadLetterCount}</span></p>
            <Badge variant={queueHealth.healthy ? "success" : "danger"}>{queueHealth.healthy ? "Healthy" : "Attention needed"}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider health & dead-letter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {degradedProviders.length === 0 ? (
              <p className="text-xs text-text-muted">All providers healthy.</p>
            ) : (
              degradedProviders.map((p) => (
                <p key={p.name} className="text-xs text-danger">{p.name}: {p.detail}</p>
              ))
            )}
            <div className="border-t border-border pt-2">
              {deadLetterSamples.map((d) => (
                <p key={d.id} className="text-xs text-text-muted">
                  <span className="font-medium text-text">{d.jobType}</span> — {d.reason}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
