import type { AutopilotPacingState } from "./pacing-service";
import type { DiscoveryOrder } from "./target-planner";
import type { RebalanceAction } from "./rebalancing";
import type { TargetRisk } from "./hybrid-fill-planner";

export interface AutopilotPlan {
  workspaceId: string;
  planningWindow: string;
  idempotencyKey: string;
  pacingState: AutopilotPacingState;
  discoveryOrders: DiscoveryOrder[];
  rebalanceActions: RebalanceAction[];
  hybridFillOrders: DiscoveryOrder[];
  pauseActions: string[];
  budgetActions: string[];
  targetRisk: TargetRisk;
  reasonSummary: string;
}