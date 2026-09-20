import type { RebalanceDecision } from "@/domain/autopilot/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Non-terminal-styled activity stream rendering `RebalanceDecision`s (Prompt
 * 2 §2.11 QuotaRebalancer output). Deliberately plain prose, not a raw log —
 * this is meant to read like an operator-facing explanation, not a debug
 * dump (a minimal raw-logs drawer for dead-letter reasons is a separate,
 * intentionally small addition).
 */
export function RebalanceActivity({ decisions }: { decisions: readonly RebalanceDecision[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rebalancing activity</CardTitle>
      </CardHeader>
      <CardContent>
        {decisions.length === 0 ? (
          <p className="text-xs text-text-muted">No rebalancing needed — every engine is on target.</p>
        ) : (
          <ul className="space-y-3">
            {decisions.map((decision) => (
              <li key={decision.id} className="text-xs text-text-muted">
                {decision.reason}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
