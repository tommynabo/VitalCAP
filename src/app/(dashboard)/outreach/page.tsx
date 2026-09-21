"use client";

import { useMemo, useState } from "react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PhasePlaceholder } from "@/components/shared/phase-placeholder";
import {
  seedAccountBundles,
  seedCampaigns,
  seedOutreachEvents,
  seedOutreachQueueItems,
} from "@/lib/seed/dev-seed";
import type { ContactPointType } from "@/domain/contacts/types";
import type { OutreachEventState } from "@/domain/outreach/types";

const STATE_VARIANT: Record<OutreachEventState, "success" | "warning" | "danger" | "neutral" | "primary"> = {
  queued: "neutral",
  scheduled: "primary",
  provider_submitted: "primary",
  sent: "success",
  delivered: "success",
  replied: "success",
  failed: "danger",
  bounced: "danger",
  unsubscribed: "danger",
  canceled: "neutral",
  suppressed: "warning",
};

const ALL_CHANNELS: ContactPointType[] = ["email", "phone", "linkedin", "other"];

export default function OutreachPage() {
  const [channelFilter, setChannelFilter] = useState<ContactPointType | "all">("all");
  const [campaignFilter, setCampaignFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<OutreachEventState | "all">("all");

  const accountsById = useMemo(() => new Map(seedAccountBundles.map((b) => [b.account.id, b.account])), []);
  const campaignsById = useMemo(() => new Map(seedCampaigns.map((c) => [c.id, c])), []);
  const contactPointsById = useMemo(
    () => new Map(seedAccountBundles.flatMap((b) => b.contactPoints).map((cp) => [cp.id, cp])),
    [],
  );

  const kpis = useMemo(() => {
    const sentToday = seedOutreachQueueItems.filter((q) => q.state === "sent" || q.state === "delivered").length;
    const scheduledToday = seedOutreachQueueItems.filter((q) => q.state === "scheduled" || q.state === "queued").length;
    const emailCount = seedOutreachQueueItems.filter((q) => q.channel === "email").length;
    const smsCount = seedOutreachQueueItems.filter((q) => q.channel === "phone").length;
    const bounces = seedOutreachEvents.filter((e) => e.state === "bounced").length;
    const replies = seedOutreachEvents.filter((e) => e.state === "replied").length;
    const optOuts = seedOutreachEvents.filter((e) => e.state === "unsubscribed").length;
    return { sentToday, scheduledToday, emailCount, smsCount, bounces, replies, optOuts };
  }, []);

  const rows = useMemo(() => {
    return seedOutreachQueueItems
      .filter((item) => (channelFilter === "all" ? true : item.channel === channelFilter))
      .filter((item) => (campaignFilter === "all" ? true : item.campaignId === campaignFilter))
      .filter((item) => (stateFilter === "all" ? true : item.state === stateFilter));
  }, [channelFilter, campaignFilter, stateFilter]);

  return (
    <PhasePlaceholder
      title="Outreach"
      phase="Prompt 3"
      description="Channel routing, sender pool health, suppression and the scheduled/sent/replies/failed/suppressed queue tabs are implemented in Phase 3. Delivery starts in dry_run mode by default."
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Scheduled today" value={String(kpis.scheduledToday)} emphasize />
        <KpiStat label="Sent today" value={String(kpis.sentToday)} />
        <KpiStat label="Email / SMS" value={`${kpis.emailCount} / ${kpis.smsCount}`} />
        <KpiStat label="Bounces" value={String(kpis.bounces)} />
        <KpiStat label="Replies" value={String(kpis.replies)} />
        <KpiStat label="Opt-outs" value={String(kpis.optOuts)} />
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Outreach queue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-3">
              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value as ContactPointType | "all")}
              >
                <option value="all">All channels</option>
                {ALL_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
                value={campaignFilter}
                onChange={(e) => setCampaignFilter(e.target.value)}
              >
                <option value="all">All campaigns</option>
                {seedCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value as OutreachEventState | "all")}
              >
                <option value="all">All states</option>
                {Object.keys(STATE_VARIANT).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Endpoint</th>
                    <th className="py-2 pr-4">Channel</th>
                    <th className="py-2 pr-4">Campaign</th>
                    <th className="py-2 pr-4">Priority</th>
                    <th className="py-2 pr-4">Scheduled</th>
                    <th className="py-2 pr-4">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const account = accountsById.get(item.accountId);
                    const campaign = campaignsById.get(item.campaignId);
                    const contactPoint = contactPointsById.get(item.contactPointId);
                    return (
                      <tr key={item.id} className="border-b border-border/60">
                        <td className="py-2 pr-4 text-text">{account?.canonicalName ?? item.accountId}</td>
                        <td className="py-2 pr-4 text-text-muted">{contactPoint?.value ?? item.contactPointId}</td>
                        <td className="py-2 pr-4 text-text-muted">{item.channel}</td>
                        <td className="py-2 pr-4 text-text-muted">{campaign?.name ?? item.campaignId}</td>
                        <td className="py-2 pr-4 text-text-muted">{item.priority}</td>
                        <td className="py-2 pr-4 text-text-muted">
                          {item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={STATE_VARIANT[item.state]}>{item.state}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-text-muted">
                        No queue items match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </PhasePlaceholder>
  );
}
