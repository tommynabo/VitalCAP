import type { DiscoveryEngine } from "@/domain/discovery/types";
import type { EngineType } from "@/domain/campaigns/types";

/**
 * Thin dispatcher over the shared `DiscoveryEngine` contract (Prompt 2
 * §2.1). Deliberately contains zero engine-specific logic — it only routes
 * by `engineType` to the concrete engine instance the caller registered.
 */
export class DiscoveryRouter {
  private readonly engines: Map<EngineType, DiscoveryEngine>;

  constructor(engines: readonly DiscoveryEngine[]) {
    this.engines = new Map(engines.map((engine) => [engine.engineType, engine]));
  }

  engineFor(engineType: EngineType): DiscoveryEngine {
    const engine = this.engines.get(engineType);
    if (!engine) throw new Error(`No discovery engine registered for engineType "${engineType}"`);
    return engine;
  }

  has(engineType: EngineType): boolean {
    return this.engines.has(engineType);
  }
}
