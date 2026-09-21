import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { summarizeSenderPoolCapacity } from "@/services/outreach/sender-pool-service";
import {
  seedEmailVerificationUsage,
  seedMailboxes,
  seedProviderRows,
  seedSendingDomains,
  type ProviderRowStatus,
} from "@/lib/seed/dev-seed";
import type { SendingDomain } from "@/domain/outreach/types";

const DOMAIN_STATUS_VARIANT: Record<SendingDomain["status"], "success" | "warning" | "danger" | "neutral"> = {
  connected: "success",
  degraded: "warning",
  paused: "danger",
  missing_configuration: "neutral",
};

const PROVIDER_STATUS_VARIANT: Record<ProviderRowStatus, "success" | "warning" | "danger" | "neutral"> = DOMAIN_STATUS_VARIANT;

export default function InfrastructurePage() {
  const capacity = summarizeSenderPoolCapacity({ mailboxes: seedMailboxes, sendingDomains: seedSendingDomains });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Infrastructure</h2>
        <p className="text-sm text-text-muted">
          Sending domains, mailboxes and every external provider adapter this workspace depends on. No secret
          values are ever displayed after save.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiStat label="Remaining capacity" value={String(capacity.totalRemainingCapacity)} emphasize />
        <KpiStat label="Daily capacity" value={String(capacity.totalDailyCapacity)} />
        <KpiStat label="Sent today" value={String(capacity.totalSentToday)} />
        <KpiStat label="Usable mailboxes" value={String(capacity.usableMailboxCount)} />
        <KpiStat label="Paused / unhealthy" value={String(capacity.pausedOrUnhealthyMailboxCount)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sending domains</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {seedSendingDomains.map((domain) => (
              <div key={domain.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text">{domain.domain}</p>
                  <p className="text-xs text-text-muted">Warmup: {domain.warmupStatus}</p>
                </div>
                <Badge variant={DOMAIN_STATUS_VARIANT[domain.status]}>{domain.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mailboxes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {seedMailboxes.map((mailbox) => (
              <div key={mailbox.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text">{mailbox.email}</p>
                  <p className="text-xs text-text-muted">
                    {mailbox.sentToday}/{mailbox.dailyCapacity} sent · health {mailbox.healthScore}
                  </p>
                </div>
                <Badge variant={mailbox.pausedReason ? "danger" : "success"}>{mailbox.pausedReason ? "Paused" : "Active"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider status</CardTitle>
          <span className="text-xs text-text-muted">Last successful call: just now (mock mode)</span>
        </CardHeader>
        <CardContent className="space-y-3">
          {seedProviderRows.map((row) => (
            <div key={row.name} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-text">{row.name}</p>
                <p className="text-xs text-text-muted">{row.detail}</p>
              </div>
              <Badge variant={PROVIDER_STATUS_VARIANT[row.status]}>{row.status.replace("_", " ")}</Badge>
            </div>
          ))}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium text-text">Email verification quota</p>
              <p className="text-xs text-text-muted">
                {seedEmailVerificationUsage.items} verified this month · {seedEmailVerificationUsage.errors} errors
              </p>
            </div>
            <Badge
              variant={
                seedEmailVerificationUsage.quotaRemaining !== null && seedEmailVerificationUsage.quotaRemaining < 150
                  ? "warning"
                  : "success"
              }
            >
              {seedEmailVerificationUsage.quotaRemaining ?? "—"} remaining
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

