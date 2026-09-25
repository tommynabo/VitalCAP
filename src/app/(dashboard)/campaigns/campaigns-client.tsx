"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import type { Campaign, EngineType, Offer } from "@/domain/campaigns/types";
import type { Conversation, Meeting } from "@/domain/conversations/types";
import type { EngineTargetState } from "@/domain/autopilot/types";
import type { OutreachQueueItem } from "@/domain/outreach/types";

const ENGINE_LABELS: Record<EngineType, string> = {
  maps_fast: "Maps Fast",
  maps_deep: "Maps Deep",
  google_serp: "Google SERP",
  linkedin_owner: "LinkedIn Owner",
  hybrid_fill: "Hybrid Fill",
};

interface CampaignsData {
  campaigns: Campaign[];
  conversations: Conversation[];
  engineTargets: EngineTargetState[];
  meetings: Meeting[];
  offer: Offer | null;
  outreachQueueItems: OutreachQueueItem[];
}

function campaignMetrics(campaign: Campaign, data: CampaignsData) {
  const conversations = data.conversations.filter((c) => c.campaignId === campaign.id);
  const conversationIds = new Set(conversations.map((c) => c.id));
  const meetings = data.meetings.filter((m) => conversationIds.has(m.conversationId)).length;
  const sent = data.outreachQueueItems.filter((q) => q.campaignId === campaign.id).length;
  const replyRate = sent > 0 ? Math.round((conversations.length / sent) * 100) : 0;
  const engine = data.engineTargets.find((e) => e.engineType === campaign.engineType);
  return { replies: conversations.length, meetings, replyRate, health: engine?.providerHealth ?? "unknown" };
}

const HEALTH_VARIANT: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  paused: "danger",
  unknown: "neutral",
};

const DETAIL_TABS = [
  { value: "overview", label: "Overview" },
  { value: "engine", label: "Engine config" },
  { value: "target", label: "Target & schedule" },
  { value: "icp", label: "ICP" },
  { value: "outreach", label: "Outreach" },
  { value: "setter", label: "Setter" },
  { value: "activity", label: "Activity" },
  { value: "settings", label: "Settings" },
];

function CampaignDetail({ campaign, data }: { campaign: Campaign; data: CampaignsData }) {
  const metrics = campaignMetrics(campaign, data);
  return (
    <Tabs items={DETAIL_TABS} defaultValue="overview">
      {(active) => {
        if (active === "overview") {
          return (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-text-muted">Engine</p>
                  <p className="font-medium text-text">{ENGINE_LABELS[campaign.engineType]}</p>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Status</p>
                  <Badge variant="neutral">{campaign.status}</Badge>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Reply rate</p>
                  <p className="font-medium text-text">{metrics.replyRate}%</p>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Meetings</p>
                  <p className="font-medium text-text">{metrics.meetings}</p>
                </div>
              </div>
              <p className="text-xs text-text-muted">
                {campaign.description ?? "No description yet — add one under Settings."}
              </p>
            </div>
          );
        }
        if (active === "engine") {
          return (
            <details className="rounded-[10px] border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-text">Advanced JSON config</summary>
              <pre className="mt-3 overflow-x-auto rounded-[10px] bg-surface-muted p-3 text-xs text-text-muted">
                {JSON.stringify(campaign.engineConfig, null, 2) || "{}"}
              </pre>
            </details>
          );
        }
        if (active === "target") {
          return (
            <div className="space-y-2 text-sm">
              <p className="text-text-muted">
                Daily soft target: <span className="font-medium text-text">{campaign.dailySoftTarget}</span>
              </p>
              <p className="text-text-muted">
                Channel mix: <span className="font-medium text-text">{campaign.desiredChannelMix.email}% email / {campaign.desiredChannelMix.sms}% SMS</span>
              </p>
              <p className="text-text-muted">
                Timezone: <span className="font-medium text-text">{campaign.timeZone}</span>
              </p>
              <p className="text-text-muted">
                Autopilot: <span className="font-medium text-text">{campaign.autopilotEnabled ? "Enabled" : "Disabled"}</span>
              </p>
            </div>
          );
        }
        if (active === "icp") {
          return (
            <p className="text-sm text-text-muted">
              Minimum fit score: {campaign.minimumFitScore ?? "no minimum set"}. Full ICP configuration (business
              type, province allowlist) is driven by the discovery layer, see the Discovery page for coverage.
            </p>
          );
        }
        if (active === "outreach") {
          return (
            <p className="text-sm text-text-muted">
              {data.outreachQueueItems.filter((q) => q.campaignId === campaign.id).length} queue items scheduled
              against this campaign. See the Outreach page for the full queue.
            </p>
          );
        }
        if (active === "setter") {
          return (
            <p className="text-sm text-text-muted">
              Offer: <span className="font-medium text-text">{data.offer?.name ?? "no offer configured"}</span> · {metrics.replies} conversation
              {metrics.replies === 1 ? "" : "s"} routed through the AI Setter for this campaign.
            </p>
          );
        }
        if (active === "activity") {
          return (
            <p className="text-sm text-text-muted">
              {metrics.replies} replies · {metrics.meetings} meetings booked · engine health{" "}
              <Badge variant={HEALTH_VARIANT[metrics.health]}>{metrics.health}</Badge>
            </p>
          );
        }
        return (
          <p className="text-sm text-text-muted">
            Campaign settings (renaming, archiving, offer reassignment) are not persisted in this demo build — no
            database is wired yet.
          </p>
        );
      }}
    </Tabs>
  );
}

function NewCampaignForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [engineType, setEngineType] = useState<EngineType>("maps_fast");
  const [dailySoftTarget, setDailySoftTarget] = useState(50);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="campaign-name" className="text-xs font-medium text-text-muted">
          Campaign name
        </label>
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vitalcap - Maps Fast" />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="campaign-engine" className="text-xs font-medium text-text-muted">
          Discovery engine
        </label>
        <Select id="campaign-engine" value={engineType} onChange={(e) => setEngineType(e.target.value as EngineType)} className="w-full">
          {Object.entries(ENGINE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="campaign-target" className="text-xs font-medium text-text-muted">
          Daily soft target
        </label>
        <Input
          id="campaign-target"
          type="number"
          min={1}
          value={dailySoftTarget}
          onChange={(e) => setDailySoftTarget(Number(e.target.value))}
        />
      </div>
      <details className="rounded-[10px] border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-text">Advanced JSON config (optional)</summary>
        <textarea
          className="mt-3 h-24 w-full rounded-[10px] border border-border bg-surface-muted p-2 text-xs text-text-muted"
          placeholder="{}"
        />
      </details>
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Create campaign (draft)</Button>
      </div>
    </form>
  );
}

export function CampaignsClient(data: CampaignsData) {
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New campaign
          </Button>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-text-muted">
            One campaign per discovery engine, disabled by default until provider credentials and campaign
            mappings are configured. Click a row for the full campaign detail.
          </p>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>Campaign</TableHeadCell>
                <TableHeadCell>Engine</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Soft target</TableHeadCell>
                <TableHeadCell>Today</TableHeadCell>
                <TableHeadCell>Channel mix</TableHeadCell>
                <TableHeadCell>Reply rate</TableHeadCell>
                <TableHeadCell>Meetings</TableHeadCell>
                <TableHeadCell>Health</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.campaigns.map((campaign) => {
                const metrics = campaignMetrics(campaign, data);
                const engine = data.engineTargets.find((e) => e.engineType === campaign.engineType);
                return (
                  <TableRow
                    key={campaign.id}
                    className="cursor-pointer hover:bg-surface-muted"
                    onClick={() => setSelected(campaign)}
                  >
                    <TableCell className="font-medium text-text">{campaign.name}</TableCell>
                    <TableCell>{ENGINE_LABELS[campaign.engineType]}</TableCell>
                    <TableCell>
                      <Badge variant="neutral">{campaign.status}</Badge>
                    </TableCell>
                    <TableCell>{campaign.dailySoftTarget}</TableCell>
                    <TableCell>{engine?.readyToday ?? "—"}</TableCell>
                    <TableCell>
                      {campaign.desiredChannelMix.email}% / {campaign.desiredChannelMix.sms}%
                    </TableCell>
                    <TableCell>{metrics.replyRate}%</TableCell>
                    <TableCell>{metrics.meetings}</TableCell>
                    <TableCell>
                      <Badge variant={HEALTH_VARIANT[metrics.health]}>{metrics.health}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.name ?? ""} description="Campaign detail">
        {selected ? <CampaignDetail campaign={selected} data={data} /> : null}
      </Sheet>

      <Sheet open={creating} onClose={() => setCreating(false)} title="New campaign" description="Guided setup — advanced config stays optional">
        <NewCampaignForm onClose={() => setCreating(false)} />
      </Sheet>
    </div>
  );
}
