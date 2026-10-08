"use client";

import { useMemo, useState } from "react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MixBar } from "@/components/ui/charts";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import type { ContactPointType } from "@/domain/contacts/types";
import type { OutreachEventState } from "@/domain/outreach/types";
import {
  mergeOutreachQueuePageData,
  type OutreachDashboardData,
  type OutreachQueuePageData,
  type OutreachQueueTab,
} from "@/services/outreach/outreach-dashboard";

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

function getQueuePageKey(tab: OutreachQueueTab, channel: ContactPointType | "all", campaignId: string) {
  return `${tab}:${campaignId}:${channel}`;
}

export function OutreachClient({ initialData }: { initialData: OutreachDashboardData }) {
  const [channelFilter, setChannelFilter] = useState<ContactPointType | "all">("all");
  const [campaignFilter, setCampaignFilter] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<OutreachQueueTab>("scheduled");
  const [queuePages, setQueuePages] = useState<Record<string, OutreachQueuePageData>>(() => ({
    [getQueuePageKey("scheduled", "all", "all")]: {
      items: initialData.items,
      accounts: initialData.accounts,
      contactPoints: initialData.contactPoints,
      nextCursor: initialData.nextCursor,
    },
  }));
  const [loadingPageKeys, setLoadingPageKeys] = useState<string[]>([]);
  const [queueErrors, setQueueErrors] = useState<Record<string, string>>({});

  const activePageKey = getQueuePageKey(activeTab, channelFilter, campaignFilter);
  const activePage = queuePages[activePageKey];
  const currentItems = activePage?.items;
  const accountsById = useMemo(() => new Map(activePage?.accounts.map((account) => [account.id, account]) ?? []), [activePage]);
  const campaignsById = useMemo(() => new Map(initialData.campaigns.map((campaign) => [campaign.id, campaign])), [initialData.campaigns]);
  const contactPointsById = useMemo(
    () => new Map(activePage?.contactPoints.map((contactPoint) => [contactPoint.id, contactPoint]) ?? []),
    [activePage],
  );

  async function loadQueuePage(
    tab: OutreachQueueTab,
    cursor: OutreachQueuePageData["nextCursor"] = null,
    filters: { channel: ContactPointType | "all"; campaignId: string } = { channel: channelFilter, campaignId: campaignFilter },
  ) {
    const queueKey = getQueuePageKey(tab, filters.channel, filters.campaignId);
    const pageKey = `${queueKey}:${cursor?.id ?? "first"}`;
    if (loadingPageKeys.includes(pageKey)) return;
    setLoadingPageKeys((current) => [...current, pageKey]);
    setQueueErrors((current) => ({ ...current, [tab]: "" }));
    try {
      const params = new URLSearchParams({ tab });
      if (filters.channel !== "all") params.set("channel", filters.channel);
      if (filters.campaignId !== "all") params.set("campaignId", filters.campaignId);
      if (cursor) params.set("cursor", JSON.stringify(cursor));
      const response = await fetch(`/api/outreach/queue?${params.toString()}`, { cache: "no-store" });
      const page = await response.json().catch(() => null) as OutreachQueuePageData | null;
      if (!response.ok || !page) throw new Error("Could not load outreach queue items.");
      setQueuePages((current) => ({
        ...current,
        [queueKey]: cursor && current[queueKey] ? mergeOutreachQueuePageData(current[queueKey]!, page) : page,
      }));
    } catch (error) {
      setQueueErrors((current) => ({ ...current, [queueKey]: error instanceof Error ? error.message : "Could not load outreach queue items." }));
    } finally {
      setLoadingPageKeys((current) => current.filter((key) => key !== pageKey));
    }
  }

  const filtered = useMemo(() => {
    return (currentItems ?? [])
      .filter((item) => (channelFilter === "all" ? true : item.channel === channelFilter))
      .filter((item) => (campaignFilter === "all" ? true : item.campaignId === campaignFilter));
  }, [currentItems, channelFilter, campaignFilter]);

  const activeFilters = { channel: channelFilter, campaignId: campaignFilter };
  const pageLoading = loadingPageKeys.includes(`${activePageKey}:first`);
  const pageLoadingMore = !!activePage?.nextCursor && loadingPageKeys.includes(`${activePageKey}:${activePage.nextCursor.id}`);

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
        <KpiStat label="Scheduled today" value={String(initialData.kpis.scheduledToday)} emphasize />
        <KpiStat label="Sent today" value={String(initialData.kpis.sentToday)} />
        <KpiStat label="Email / SMS" value={`${initialData.kpis.emailCount} / ${initialData.kpis.smsCount}`} />
        <KpiStat label="Bounces" value={String(initialData.kpis.bounces)} />
        <KpiStat label="Replies" value={String(initialData.kpis.replies)} />
        <KpiStat label="Opt-outs" value={String(initialData.kpis.optOuts)} />
      </div>

      {(initialData.kpis.bounces > 0 || initialData.kpis.optOuts > 0) && (
        <Card className="border-warning">
          <CardContent className="py-3 text-sm text-warning">
            {initialData.kpis.bounces} bounce{initialData.kpis.bounces === 1 ? "" : "s"} and {initialData.kpis.optOuts} opt-out
            {initialData.kpis.optOuts === 1 ? "" : "s"} recorded — suppression list updated automatically, no further sends to
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
                { label: "Email", value: initialData.kpis.emailCount, colorClassName: "bg-primary" },
                { label: "SMS", value: initialData.kpis.smsCount, colorClassName: "bg-warning" },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sender pool health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex justify-between"><span className="text-text-muted">Usable mailboxes</span><span className="font-medium text-text">{initialData.senderPool.usableMailboxCount}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Remaining capacity</span><span className="font-medium text-text">{initialData.senderPool.totalRemainingCapacity}</span></p>
            <p className="flex justify-between"><span className="text-text-muted">Paused / unhealthy</span><span className="font-medium text-text">{initialData.senderPool.pausedOrUnhealthyMailboxCount}</span></p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Outreach queue</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-3">
            <Select value={channelFilter} onChange={(e) => {
              const channel = e.target.value as ContactPointType | "all";
              setChannelFilter(channel);
              const filters = { channel, campaignId: campaignFilter };
              if (!queuePages[getQueuePageKey(activeTab, filters.channel, filters.campaignId)]) {
                void loadQueuePage(activeTab, null, filters);
              }
            }}>
              <option value="all">All channels</option>
              {ALL_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>

            <Select value={campaignFilter} onChange={(e) => {
              const campaignId = e.target.value;
              setCampaignFilter(campaignId);
              const filters = { channel: channelFilter, campaignId };
              if (!queuePages[getQueuePageKey(activeTab, filters.channel, filters.campaignId)]) {
                void loadQueuePage(activeTab, null, filters);
              }
            }}>
              <option value="all">All campaigns</option>
              {initialData.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>

          <Tabs
            items={QUEUE_TABS}
            value={activeTab}
            onValueChange={(value) => {
              const tab = value as OutreachQueueTab;
              setActiveTab(tab);
              if (!queuePages[getQueuePageKey(tab, channelFilter, campaignFilter)]) void loadQueuePage(tab, null, activeFilters);
            }}
          >
            {() => {
              const rows = filtered;
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
                    {rows.length === 0 && pageLoading && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-text-muted">Loading queue items...</TableCell>
                      </TableRow>
                    )}
                    {rows.length === 0 && !pageLoading && (
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
          {queueErrors[activePageKey] && <p role="alert" className="mt-3 text-sm text-danger">{queueErrors[activePageKey]}</p>}
          {activePage?.nextCursor && (
            <Button className="mt-3" size="sm" variant="secondary" disabled={pageLoadingMore} onClick={() => void loadQueuePage(activeTab, activePage.nextCursor, activeFilters)}>
              {pageLoadingMore ? "Loading..." : "Load more"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
