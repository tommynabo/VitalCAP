import { EngineCard } from "@/components/dashboard/engine-card";
import { PhasePlaceholder } from "@/components/shared/phase-placeholder";
import { getSeedGlobalAutopilotState } from "@/lib/seed/dev-seed";

export default function AutopilotPage() {
  const state = getSeedGlobalAutopilotState();

  return (
    <PhasePlaceholder
      title="Autopilot"
      phase="Flagship screen — Prompt 2 (Target Engine) + Prompt 5 (full UI)"
      description="The Autopilot Target Engine (scheduler, quota rebalancer, provider health, pacing) is implemented in Phase 2; the full flagship layout with target allocation visualization and dead-letter warnings ships in Phase 5. Below is a read-only preview using seed engine state."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {state.engines.map((engine) => (
          <EngineCard key={engine.engineType} engine={engine} />
        ))}
      </div>
    </PhasePlaceholder>
  );
}
