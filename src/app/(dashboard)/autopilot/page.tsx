import { EngineCard } from "@/components/dashboard/engine-card";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { RebalanceActivity } from "@/components/dashboard/rebalance-activity";
import { PhasePlaceholder } from "@/components/shared/phase-placeholder";
import { globalProgressPct, sumSoftTargets } from "@/lib/autopilot/targets";
import { getSeedGlobalAutopilotState, seedRebalanceDecisions } from "@/lib/seed/dev-seed";

export default function AutopilotPage() {
  const state = getSeedGlobalAutopilotState();
  const progressPct = globalProgressPct(state.dailyTarget, state.engines);
  const softTargetTotal = sumSoftTargets(state.engines);

  return (
    <PhasePlaceholder
      title="Autopilot"
      phase="Flagship screen — Prompt 2 (Target Engine) + Prompt 5 (full UI)"
      description="The Autopilot Target Engine (scheduler, quota rebalancer, provider health, pacing) is implemented in Phase 2; the full flagship layout with target allocation visualization and dead-letter warnings ships in Phase 5. Below is a read-only preview using seed engine state."
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Ready" value={`${state.readyToday}/${state.dailyTarget}`} emphasize />
        <KpiStat label="Progress" value={`${progressPct}%`} />
        <KpiStat label="Soft target total" value={String(softTargetTotal)} />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Ready buffer" value={state.readyBufferDays.toFixed(1)} suffix="days" />
        <KpiStat label="System health" value={state.systemHealth} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold text-text">Discovery engines</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {state.engines.map((engine) => (
              <EngineCard key={engine.engineType} engine={engine} />
            ))}
          </div>
        </div>
        <RebalanceActivity decisions={seedRebalanceDecisions} />
      </div>
    </PhasePlaceholder>
  );
}
