"use client";

import { useMemo, useState } from "react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MixBar } from "@/components/ui/charts";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { summarizeSenderPoolCapacity } from "@/services/outreach/sender-pool-service";
import {
  seedAccountBundles,
  seedCampaigns,
  seedMailboxes,
  seedOutreachEvents,
  seedOutreachQueueItems,
  seedSendingDomains,
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

const QUEUE_TABS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "sent", label: "Sent" },
  { value: "replies", label: "Replies" },
  { value: "failed", label: "Failed" },
  { value: "suppressed", label: "Suppressed" },
];

const TAB_STATES: Record<string, OutreachEventState[]> = {
  scheduled: ["scheduled", "queued", "provider_submitted"],
  sent: ["sent", "delivered"],
  replies: ["replied"],
  failed: ["failed", "bounced"],
  suppressed: ["suppressed", "unsubscribed", "canceled"],
};

export default function OutreachPage() {
  const [channelFilter, setChannelFilter] = useState<ContactPointType | "all">("all");
  const [campaignFilter, setCampaignFilter] = useState<string>("all");

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

  const capacity = summarizeSenderPoolCapacity({ mailboxes: seedMailboxes, sendingDomains: seedSendingDomains });

  const filtered = useMemo(() => {
    return seedOutreachQueueItems
      .filter((item) => (channelFilter === "all" ? true : item.channel === channelFilter))
      .filter((item) => (campaignFilter === "all" ? true : item.campaignId === campaignFilter));
  }, [channelFilter, campaignFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Outreach</h2>
        <p className="text-sm text-text-muted">
          Channel routing, sender pool health and suppression enforcement. Delivery starts in dry_run mode by
          default — no message leaves this workspace until an operator flips a campaign to live.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Scheduled today" value={String(kpis.scheduledToday)} emphasize />
        <KpiStat label="Sent today" value={String(kpis.sentToday)} />
        <KpiStat label="Email / SMS" value={`${kpis.emailCount} / ${kpis.smsCount}`} />
        <KpiStat label="Bounces" value={String(kpis.bounces)} />
        <KpiStat label="Replies" value={String(kpis.replies)} />
        <KpiStat label="Opt-outs" value={String(kpis.optOuts)} />
      </div>

      {(kpis.bounces > 0 || kpis.optOuts > 0) && (
        <Card className="border-warning">
          <CardContent className="py-3 text-sm text-warning">
            {kpis.bounces} bounce{kpis.bounces === 1 ? "" : "s"} and {kpis.optOuts} opt-out
            {kpis.optOuts === 1 ? "" : "s"} recorded — suppression list updated automatically, no further sends to
            those endpoints.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Channel mix</CardTitle>
          </CardHeader>
          <CardContent>
            <MixBar
              segments={[
                { label: "Email", value: kpis.emailCount, colorClassName: "bg-primary" },
                { label: "SMS", value: kpis.smsCount, colorClassName: "bg-warning" },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sender pool health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex justify-between"><span className="text-text-muted">Usable mailboxes</span><span className="font-medium text-text">{capacity.usableMailboxCount}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Remaining capacity</span><span className="font-medium text-text">{capacity.totalRemainingCapacity}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Paused / unhealthy</span><span className="font-medium text-text">{capacity.pausedOrUnhealthyMailboxCount}</span></p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Outreach queue</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-3">
            <Select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as ContactPointType | "all")}>
              <option value="all">All channels</option>
              {ALL_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>

            <Select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}>
              <option value="all">All campaigns</option>
              {seedCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>

          <Tabs items={QUEUE_TABS} defaultValue="scheduled">
            {(active) => {
              const states = TAB_STATES[active] ?? [];
              const rows = filtered.filter((item) => states.includes(item.state));
              return (
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>Account</TableHeadCell>
                      <TableHeadCell>Endpoint</TableHeadCell>
                      <TableHeadCell>Channel</TableHeadCell>
                      <TableHeadCell>Campaign</TableHeadCell>
                      <TableHeadCell>Priority</TableHeadCell>
                      <TableHeadCell>Scheduled</TableHeadCell>
                      <TableHeadCell>State</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((item) => {
                      const account = accountsById.get(item.accountId);
                      const campaign = campaignsById.get(item.campaignId);
                      const contactPoint = contactPointsById.get(item.contactPointId);
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="text-text">{account?.canonicalName ?? item.accountId}</TableCell>
                          <TableCell className="text-text-muted">{contactPoint?.value ?? item.contactPointId}</TableCell>
                          <TableCell className="text-text-muted">{item.channel}</TableCell>
                          <TableCell className="text-text-muted">{campaign?.name ?? item.campaignId}</TableCell>
                          <TableCell className="text-text-muted">{item.priority}</TableCell>
                          <TableCell className="text-text-muted">
                            {item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={STATE_VARIANT[item.state]}>{item.state}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-text-muted">
                          No queue items in this bucket.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              );
            }}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

