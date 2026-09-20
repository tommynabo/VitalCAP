import { EngineCard } from "@/components/dashboard/engine-card";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { RebalanceActivity } from "@/components/dashboard/rebalance-activity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { globalProgressPct } from "@/lib/autopilot/targets";
import { getSeedGlobalAutopilotState, seedRebalanceDecisions } from "@/lib/seed/dev-seed";

export default function DashboardPage() {
  const state = getSeedGlobalAutopilotState();
  const progressPct = globalProgressPct(state.dailyTarget, state.engines);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Good morning</h2>
        <p className="text-sm text-text-muted">
          {new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })} · Autopilot
          status overview
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiStat label="Daily target" value={String(state.dailyTarget)} />
        <KpiStat label="Ready today" value={String(state.readyToday)} emphasize />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Replies" value={String(state.repliesToday)} />
        <KpiStat label="Meetings" value={String(state.meetingsToday)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Autopilot progress</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-text">
              {state.readyToday} <span className="text-base font-normal text-text-muted">/ {state.dailyTarget}</span>
            </p>
            <Progress value={progressPct} className="mt-3" />
            <p className="mt-3 text-xs text-text-muted">
              Ready buffer: {state.readyBufferDays.toFixed(1)} days · System health:{" "}
              <span className="font-medium text-text">{state.systemHealth}</span>
            </p>
          </CardContent>
        </Card>

        <RebalanceActivity decisions={seedRebalanceDecisions} />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Discovery engines</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {state.engines.map((engine) => (
            <EngineCard key={engine.engineType} engine={engine} />
          ))}
        </div>
      </div>
    </div>
  );
}
