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
import type { GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";

interface ProviderRow {
  name: string;
  status: ProviderRowStatus;
  detail: string;
}

export function AutopilotClient({
  state,
  deadLetterSamples,
  providerRows,
  queueHealth,
  rebalanceDecisions,
}: {
  state: GlobalAutopilotState;
  deadLetterSamples: DeadLetterSample[];
  providerRows: ProviderRow[];
  queueHealth: QueueHealthSnapshot;
  rebalanceDecisions: RebalanceDecision[];
}) {
  const progressPct = globalProgressPct(state.dailyTarget, state.engines);
  const softTargetTotal = sumSoftTargets(state.engines);
  const [running, setRunning] = useState(true);

  const degradedProviders = providerRows.filter((p) => p.status === "degraded" || p.status === "paused");

  return (
    <div className="space-y-6">
      <Card className={!running ? "border-warning" : undefined}>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div>
            <p className="text-sm font-semibold text-text">
              Autopilot is {running ? "running" : "paused"}
            </p>
            <p className="text-xs text-text-muted">
              {running
                ? `Targeting ${state.dailyTarget} ready leads/day across ${state.engines.length} engines · system health ${state.systemHealth}`
                : "No new discovery, verification or outreach jobs will be scheduled until resumed."}
            </p>
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button variant="secondary" size="sm" onClick={() => setRunning(false)}>
                <Pause className="h-4 w-4" aria-hidden="true" />
                Pause
              </Button>
            ) : (
              <Button size="sm" onClick={() => setRunning(true)}>
                <Play className="h-4 w-4" aria-hidden="true" />
                Resume
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={() => setRunning(false)}>
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Emergency stop
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Ready" value={`${state.readyToday}/${state.dailyTarget}`} emphasize />
        <KpiStat label="Progress" value={`${progressPct}%`} />
        <KpiStat label="Soft target total" value={String(softTargetTotal)} />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Ready buffer" value={state.readyBufferDays.toFixed(1)} suffix="days" />
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
