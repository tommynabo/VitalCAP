import { AlertTriangle, Gauge, Inbox, Mail, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  seedEmailVerificationUsage,
  seedMailboxes,
  seedProviderRows,
  seedConversations,
  seedRebalanceDecisions,
} from "@/lib/seed/dev-seed";

interface ActivityItem {
  id: string;
  icon: LucideIcon;
  text: string;
  variant: "neutral" | "primary" | "warning" | "danger";
}

/**
 * Consolidated "what needs my attention" feed (Prompt 5 §5.3 right rail):
 * provider alerts, target rebalance, replies needing review, mailbox
 * issues, verification quota warnings — one operator-facing stream rather
 * than several small unrelated cards.
 */
export function ActivityRail() {
  const items: ActivityItem[] = [];

  for (const decision of seedRebalanceDecisions) {
    items.push({ id: decision.id, icon: Gauge, text: decision.reason, variant: "primary" });
  }

  const pendingReview = seedConversations.filter((c) => c.state === "pending_review").length;
  if (pendingReview > 0) {
    items.push({
      id: "pending-review",
      icon: Inbox,
      text: `${pendingReview} repl${pendingReview === 1 ? "y" : "ies"} waiting for human review`,
      variant: "warning",
    });
  }

  for (const mailbox of seedMailboxes) {
    if (mailbox.pausedReason) {
      items.push({ id: mailbox.id, icon: Mail, text: `${mailbox.email} paused — ${mailbox.pausedReason}`, variant: "danger" });
    }
  }

  for (const provider of seedProviderRows) {
    if (provider.status === "degraded" || provider.status === "paused") {
      items.push({ id: provider.name, icon: AlertTriangle, text: `${provider.name}: ${provider.detail}`, variant: "danger" });
    }
  }

  if (seedEmailVerificationUsage.quotaRemaining !== null && seedEmailVerificationUsage.quotaRemaining < 150) {
    items.push({
      id: "verification-quota",
      icon: ShieldAlert,
      text: `Email verification quota running low — ${seedEmailVerificationUsage.quotaRemaining} checks remaining`,
      variant: "warning",
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs your attention</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-text-muted">Nothing needs attention right now — every system is on target.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.id} className="flex items-start gap-2.5">
                  <span
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                    aria-hidden="true"
                  >
                    <Icon
                      className={
                        item.variant === "danger"
                          ? "h-4 w-4 text-danger"
                          : item.variant === "warning"
                            ? "h-4 w-4 text-warning"
                            : "h-4 w-4 text-primary"
                      }
                    />
                  </span>
                  <p className="text-xs text-text-muted">{item.text}</p>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 border-t border-border pt-3">
          <Badge variant="neutral">{items.length} active item{items.length === 1 ? "" : "s"}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
