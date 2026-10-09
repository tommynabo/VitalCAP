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
import type { DeadLetterSample, InstantlyPipelineDiagnostics, ProviderRowStatus, QueueHealthSnapshot } from "@/lib/data/repository";
import { getEffectiveAutopilotState, type AutopilotSettings, type GlobalAutopilotState, type RebalanceDecision } from "@/domain/autopilot/types";

interface ProviderRow {
  name: string;
  status: ProviderRowStatus;
  detail: string;
}

function formatTimestamp(value: string | null, timeZone: string): string {
  if (!value) return "N/A";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "medium", timeZone }).format(new Date(value));
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
  instantlyPipeline,
}: {
  state: GlobalAutopilotState;
  settings: AutopilotSettings;
  lastAutopilotCron: string | null;
  lastDiscoveryCron: string | null;
  deadLetterSamples: DeadLetterSample[];
  providerRows: ProviderRow[];
  queueHealth: QueueHealthSnapshot;
  rebalanceDecisions: RebalanceDecision[];
  instantlyPipeline: InstantlyPipelineDiagnostics | null;
}) {
  const softTargetTotal = sumSoftTargets(state.engines);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveState = getEffectiveAutopilotState(settings);
  const pacing = state.pacing;
  const progressPct = settings.targetMetric === "instantly_imported"
    ? Math.min(100, Math.round(((pacing?.targetAchievedToday ?? 0) / Math.max(1, state.dailyTarget)) * 100))
    : globalProgressPct(state.dailyTarget, state.engines);
  const [targetInput, setTargetInput] = useState(String(settings.globalDailyTarget));
  const [targetMetric, setTargetMetric] = useState(settings.targetMetric);
  const targetLabel = settings.targetMetric === "instantly_imported" ? "Instantly añadidos" : "qualified prospects";

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
      <Card className={effectiveState === "system_paused" ? "border-danger bg-danger/5" : effectiveState !== "running" ? "border-warning" : undefined}>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div>
            <p className="text-sm font-semibold text-text">
              {effectiveState === "system_paused" ? "SYSTEM PAUSED" : `Autopilot is ${effectiveState === "running" ? "running" : effectiveState === "paused" ? "paused" : "emergency stopped"}`}
            </p>
            <p className="text-xs text-text-muted">
              {effectiveState === "running" ? `Targeting ${settings.globalDailyTarget} ${targetLabel}/day across ${state.engines.length} engines` : effectiveState === "system_paused" ? (settings.systemPauseReason ?? "Recovery required before new discovery can run.") : effectiveState === "paused" ? "New discovery is paused; existing processing jobs may drain safely." : "Emergency stop blocks new discovery, processing claims, and outreach scheduling."}
            </p>
          </div>
          <div className="flex gap-2">
            {effectiveState === "running" ? (
              <Button variant="secondary" size="sm" disabled={pendingAction !== null} onClick={() => control({ action: "pause" })}>
                <Pause className="h-4 w-4" aria-hidden="true" />
                Pause
              </Button>
            ) : (
              <Button size="sm" disabled={pendingAction !== null || effectiveState === "emergency_stopped" || effectiveState === "system_paused"} onClick={() => control({ action: "resume" })}>
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

      <p className="text-xs text-text-muted">Last Autopilot cron: {formatTimestamp(lastAutopilotCron, settings.timezone)} · Last discovery cron: {formatTimestamp(lastDiscoveryCron, settings.timezone)}</p>

      <Card>
        <CardHeader><CardTitle>Global daily target</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-text-muted">Target/day<input className="mt-1 block w-28 rounded border border-border bg-surface px-2 py-1 text-text" type="number" min="1" max="250" value={targetInput} onChange={(event) => setTargetInput(event.target.value)} /></label>
          <label className="text-sm text-text-muted">Target metric<select className="mt-1 block rounded border border-border bg-surface px-2 py-1 text-text" value={targetMetric} onChange={(event) => setTargetMetric(event.target.value as AutopilotSettings["targetMetric"])}>
            <option value="qualified">Qualified</option>
            <option value="analyzed_qualified">Analyzed qualified</option>
            <option value="outreach_ready">Outreach ready</option>
            <option value="instantly_imported">Instantly added</option>
          </select></label>
          <Button size="sm" disabled={pendingAction !== null} onClick={() => void control({ action: "target_change", globalDailyTarget: Number(targetInput), targetMetric })}>Save target</Button>
          <span className="text-xs text-text-muted">Recommended 250 · timezone {settings.timezone}</span>
          {softTargetTotal !== settings.globalDailyTarget && <span className="text-xs text-warning">Campaign soft targets total {softTargetTotal}; allocation is not changed automatically.</span>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <KpiStat label={settings.targetMetric === "instantly_imported" ? "Instantly añadidos hoy" : "Qualified today"} value={`${pacing?.targetAchievedToday ?? state.targetAchievedToday ?? state.readyToday}/${state.dailyTarget}`} emphasize />
          <KpiStat label="Qualified today" value={String(pacing?.qualifiedToday ?? state.readyToday)} />
        <KpiStat label="Progress" value={`${progressPct}%`} />
        <KpiStat label="Soft target total" value={String(softTargetTotal)} />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Raw requests" value={pacing ? String(pacing.rawRequestedToday) : "Unavailable"} />
        <KpiStat label="Processing jobs" value={pacing ? String(pacing.processingInFlight) : "Unavailable"} />
        <KpiStat label="System health" value={state.systemHealth} />
      </div>

      <Card>
        <CardHeader><CardTitle>Autopilot pacing</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {pacing ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiStat label="Expected by now" value={pacing.expectedAchievedByNow.toFixed(1)} />
                <KpiStat label="Remaining" value={String(pacing.remainingTarget)} />
                <KpiStat label={pacing.targetMetric === "instantly_imported" ? "Expected imports from backlog" : "Expected qualified in-flight"} value={(pacing.targetMetric === "instantly_imported" ? pacing.expectedImportsFromBacklog : pacing.expectedQualifiedFromInFlight).toFixed(1)} />
                <KpiStat label="Pace deficit" value={pacing.paceDeficit.toFixed(1)} />
                <KpiStat label="Hours remaining" value={pacing.hoursRemaining.toFixed(1)} />
                <KpiStat label="Raw requests remaining" value={pacing.rawRequestCap === null ? String(pacing.rawRequestsRemaining) : `${pacing.rawRequestsRemaining}/${pacing.rawRequestCap}`} />
                <KpiStat label="Estimated raw demand" value={String(pacing.estimatedRawDemand)} />
                <KpiStat label="Apify spend" value={`$${pacing.apifySpendToday.toFixed(2)}`} />
                <KpiStat label="Budget remaining" value={`$${pacing.apifyDailyBudgetRemaining.toFixed(2)}`} />
                <KpiStat label="Active provider runs" value={String(pacing.providerRunsInFlight)} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <Badge variant={pacing.status === "behind_pace" ? "warning" : pacing.status === "on_pace" ? "success" : "neutral"}>{pacing.status.replace("_", " ")}</Badge>
                <span>{pacing.operatingStart}-{pacing.operatingEnd} {pacing.timeZone}</span>
                <span>Yield {Math.round(pacing.estimatedYield * 100)}% ({pacing.yieldSampleSize} {pacing.targetMetric === "instantly_imported" ? "source accounts" : "raw"})</span>
                {pacing.capacityConstrained && <Badge variant="warning">Capacity constrained</Badge>}
              </div>
              {pacing.targetMetric === "instantly_imported" && <div className="grid grid-cols-2 gap-3 border-y border-border py-3 sm:grid-cols-3 lg:grid-cols-6">
                <KpiStat label="Discovered" value={String(pacing.discoveredToday)} />
                <KpiStat label="With email" value={String(pacing.withEmailToday)} />
                <KpiStat label="MV valid" value={String(pacing.validEmailToday)} />
                <KpiStat label="Eligible" value={String(pacing.eligibleToday)} />
                <KpiStat label="Qualified" value={String(pacing.qualifiedToday)} />
                <KpiStat label="Verification pending" value={String(pacing.verificationInFlight)} />
                <KpiStat label="Instantly added today" value={String(pacing.instantlyImportedToday)} />
              </div>}
              <p className="text-xs text-text-muted">{pacing.explanation}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>Target risk: {state.targetRisk?.replaceAll("_", " ") ?? "Unavailable"}</span>
                <span>Hybrid Fill: {state.targetRisk === "target_at_risk_time" ? "eligible" : "inactive"}</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted">Pacing metrics are unavailable in seed mode.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historical Instantly funnel</CardTitle>
          {instantlyPipeline && <Badge variant={instantlyPipeline.circuitOpen ? "danger" : "success"}>{instantlyPipeline.circuitOpen ? "Auth circuit open" : "Auth circuit closed"}</Badge>}
        </CardHeader>
        {instantlyPipeline ? (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              <KpiStat label="Raw candidates" value={String(instantlyPipeline.rawCandidates)} />
              <KpiStat label="Processed raw" value={String(instantlyPipeline.processedCandidates)} />
              <KpiStat label="Qualified" value={String(instantlyPipeline.membershipStages.qualified ?? 0)} />
              <KpiStat label="Contact selected" value={String(instantlyPipeline.membershipStages.contact_selected ?? 0)} />
              <KpiStat label="Ready" value={String(instantlyPipeline.membershipStages.ready ?? 0)} />
              <KpiStat label="Verification pending" value={String(instantlyPipeline.verificationJobs.pending ?? 0)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <p className="text-xs text-text-muted">Email verification: {instantlyPipeline.emailVerification.valid ?? 0} valid · {instantlyPipeline.emailVerification.unverified ?? 0} unverified · {instantlyPipeline.emailVerification.unknown ?? 0} unknown</p>
              <p className="text-xs text-text-muted">Channel eligibility: {instantlyPipeline.emailEligibility.allowed ?? 0} allowed · {instantlyPipeline.emailEligibility.unknown ?? 0} unknown · {instantlyPipeline.emailEligibility.review_required ?? 0} review required</p>
              <p className="text-xs text-text-muted">Instantly imports: {Object.entries(instantlyPipeline.importStatuses).map(([status, count]) => `${status} ${count}`).join(" · ") || "none"}</p>
              <p className="text-xs text-text-muted">Outreach: {instantlyPipeline.actualOutreach} actual · {instantlyPipeline.scheduledDryRun} dry-run scheduled · {instantlyPipeline.instantlySent} Instantly sent</p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-xs text-text-muted">
              <span>Enabled campaign mappings: {instantlyPipeline.campaignMappingCount}</span>
              <span>Setter send unknown: {instantlyPipeline.setterSendUnknown}</span>
              <span>Import circuit: {instantlyPipeline.circuitOpen ? "open" : "closed"}</span>
              <span>Last successful lead write: {instantlyPipeline.lastSuccessfulLeadWriteAt ? new Date(instantlyPipeline.lastSuccessfulLeadWriteAt).toLocaleString() : "none recorded"}</span>
              {instantlyPipeline.lastSuccessfulLeadWriteCampaignId && <span>Write campaign: {instantlyPipeline.lastSuccessfulLeadWriteCampaignId}</span>}
            </div>
          </CardContent>
        ) : (
          <CardContent><p className="text-sm text-text-muted">Live Neon funnel metrics are unavailable in seed mode.</p></CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Target allocation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.engines.map((engine) => {
            const achieved = engine.targetAchievedToday ?? engine.readyToday;
            const pct = engine.softTarget > 0 ? Math.min(100, Math.round((achieved / engine.softTarget) * 100)) : 0;
            return (
              <div key={engine.engineType}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-text">{engine.engineType.replace("_", " ")}</span>
                  <span className="text-text-muted">
                    {achieved}/{engine.softTarget} qualified · {pct}%
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
            <EngineCard key={engine.engineType} engine={engine} timeZone={settings.timezone} />
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
