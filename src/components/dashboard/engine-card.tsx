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
  healthy: "success",
  degraded: "warning",
  paused: "danger",
  unknown: "neutral",
};

export function EngineCard({ engine }: { engine: EngineTargetState }) {
  const progressPct = Math.min(100, Math.round((engine.readyToday / engine.softTarget) * 100));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ENGINE_LABELS[engine.engineType]}</CardTitle>
        <Badge variant={HEALTH_VARIANT[engine.providerHealth]}>{engine.providerHealth}</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold text-text">
          {engine.readyToday} <span className="text-sm font-normal text-text-muted">/ {engine.softTarget}</span>
        </p>
        <Progress value={progressPct} className="mt-2" />
        <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-text-muted">Raw queue</dt>
            <dd className="font-medium text-text">{engine.rawQueueDepth}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Yield</dt>
            <dd className="font-medium text-text">{Math.round(engine.currentYield * 100)}%</dd>
          </div>
        </dl>
        {engine.nextPlannedAction ? (
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">{engine.nextPlannedAction}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
