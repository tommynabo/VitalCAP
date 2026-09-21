import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PhasePlaceholder } from "@/components/shared/phase-placeholder";
import { summarizeSenderPoolCapacity } from "@/services/outreach/sender-pool-service";
import { seedMailboxes, seedSendingDomains } from "@/lib/seed/dev-seed";
import type { SendingDomain } from "@/domain/outreach/types";

const DOMAIN_STATUS_VARIANT: Record<SendingDomain["status"], "success" | "warning" | "danger" | "neutral"> = {
  connected: "success",
  degraded: "warning",
  paused: "danger",
  missing_configuration: "neutral",
};

type ProviderRowStatus = "connected" | "degraded" | "paused" | "missing_configuration";

const PROVIDER_STATUS_VARIANT: Record<ProviderRowStatus, "success" | "warning" | "danger" | "neutral"> = DOMAIN_STATUS_VARIANT;

const providerRows: Array<{ name: string; status: ProviderRowStatus; detail: string }> = [
  { name: "Email delivery (Instantly)", status: "connected", detail: "Mock adapter active — no live API key configured" },
  { name: "SMS delivery", status: "connected", detail: "Mock adapter active — no live API key configured" },
  { name: "Email verification", status: "connected", detail: "Mock adapter active" },
  { name: "Maps discovery", status: "connected", detail: "Mock adapter active" },
  { name: "Google SERP", status: "connected", detail: "Mock adapter active" },
  { name: "LLM (setter drafts)", status: "missing_configuration", detail: "Owned by Phase 4" },
  { name: "Outreach webhooks", status: "connected", detail: "Signature verification enforced (HMAC-SHA256)" },
];

export default function InfrastructurePage() {
  const capacity = summarizeSenderPoolCapacity({ mailboxes: seedMailboxes, sendingDomains: seedSendingDomains });

  return (
    <PhasePlaceholder
      title="Infrastructure"
      phase="Prompt 3"
      description="Domains, mailboxes, email/SMS/verification/search/LLM provider status and webhook health are implemented in Phase 3. No secret values are ever displayed after save."
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiStat label="Remaining capacity" value={String(capacity.totalRemainingCapacity)} emphasize />
        <KpiStat label="Daily capacity" value={String(capacity.totalDailyCapacity)} />
        <KpiStat label="Sent today" value={String(capacity.totalSentToday)} />
        <KpiStat label="Usable mailboxes" value={String(capacity.usableMailboxCount)} />
        <KpiStat label="Paused / unhealthy" value={String(capacity.pausedOrUnhealthyMailboxCount)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
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

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Provider status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {providerRows.map((row) => (
              <div key={row.name} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-text">{row.name}</p>
                  <p className="text-xs text-text-muted">{row.detail}</p>
                </div>
                <Badge variant={PROVIDER_STATUS_VARIANT[row.status]}>{row.status.replace("_", " ")}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PhasePlaceholder>
  );
}
