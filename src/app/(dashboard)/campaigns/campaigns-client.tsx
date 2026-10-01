"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import type { Campaign, CampaignStatus, EngineType, Offer } from "@/domain/campaigns/types";
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

function providerWarning(engineType: EngineType, engineTargets: EngineTargetState[]) {
  const health = engineTargets.find((engine) => engine.engineType === engineType)?.providerHealth;
  if (health !== "paused") return null;
  const provider = engineType === "maps_fast" ? "Apify Maps" : engineType === "maps_deep" ? "Apify Maps and Serper" : engineType === "hybrid_fill" ? "Apify Maps or Serper" : "Serper";
  return `${provider} is not configured or is paused. The campaign can be saved, but Autopilot will not schedule it until the provider is available.`;
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

const STATUS_LABELS: Record<CampaignStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  archived: "Archived",
};

const STATUS_VARIANT: Record<CampaignStatus, "success" | "warning" | "neutral" | "danger"> = {
  active: "success",
  paused: "warning",
  draft: "neutral",
  archived: "danger",
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

function CampaignSettings({ campaign, engineTargets, onUpdated }: { campaign: Campaign; engineTargets: EngineTargetState[]; onUpdated: (campaign: Campaign) => void }) {
  const router = useRouter();
  const [status, setStatus] = useState<CampaignStatus>(campaign.status);
  const [autopilotEnabled, setAutopilotEnabled] = useState(campaign.autopilotEnabled);
  const [dailySoftTarget, setDailySoftTarget] = useState(campaign.dailySoftTarget);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warning = providerWarning(campaign.engineType, engineTargets);

  async function saveCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaign.id, status, autopilotEnabled, dailySoftTarget }),
      });
      const body = (await response.json()) as { campaign?: Campaign; error?: string };
      if (!response.ok || !body.campaign) throw new Error(body.error ?? "Campaign update failed.");
      onUpdated(body.campaign);
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Campaign update failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void saveCampaign(event)}>
      <div className="space-y-1.5">
        <label htmlFor="campaign-status" className="text-xs font-medium text-text-muted">Status</label>
        <Select id="campaign-status" value={status} onChange={(event) => setStatus(event.target.value as CampaignStatus)} className="w-full">
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="campaign-autopilot" className="text-xs font-medium text-text-muted">Autopilot</label>
        <Select id="campaign-autopilot" value={String(autopilotEnabled)} onChange={(event) => setAutopilotEnabled(event.target.value === "true")} className="w-full">
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="campaign-settings-target" className="text-xs font-medium text-text-muted">Daily soft target</label>
        <Input id="campaign-settings-target" type="number" min={1} max={250} value={dailySoftTarget} onChange={(event) => setDailySoftTarget(Number(event.target.value))} />
      </div>
      <p className="text-xs text-text-muted">Timezone: Europe/Madrid</p>
      {warning && <p className="text-xs text-warning" role="status">{warning}</p>}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

function CampaignDetail({ campaign, data, onUpdated }: { campaign: Campaign; data: CampaignsData; onUpdated: (campaign: Campaign) => void }) {
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
                  <Badge variant={STATUS_VARIANT[campaign.status]}>{STATUS_LABELS[campaign.status]}</Badge>
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
        return <CampaignSettings campaign={campaign} engineTargets={data.engineTargets} onUpdated={onUpdated} />;
      }}
    </Tabs>
  );
}

function NewCampaignForm({ onClose, offer, engineTargets }: { onClose: () => void; offer: Offer | null; engineTargets: EngineTargetState[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [engineType, setEngineType] = useState<EngineType>("maps_fast");
  const [dailySoftTarget, setDailySoftTarget] = useState(50);
  const [status, setStatus] = useState<"active" | "draft">("active");
  const [autopilotEnabled, setAutopilotEnabled] = useState(true);
  const [engineConfig, setEngineConfig] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const warning = providerWarning(engineType, engineTargets);

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let parsedEngineConfig: Record<string, unknown>;
    try {
      const parsed = JSON.parse(engineConfig || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Advanced JSON config must be an object.");
      }
      parsedEngineConfig = parsed as Record<string, unknown>;
    } catch (configError) {
      setError(configError instanceof Error ? configError.message : "Advanced JSON config must be valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          status,
          engineType,
          dailySoftTarget,
          autopilotEnabled,
          engineConfig: parsedEngineConfig,
          desiredChannelMix: { email: 100, sms: 0 },
          offerId: offer?.id ?? undefined,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Campaign creation failed.");
      onClose();
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Campaign creation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => void createCampaign(event)}
    >
      <div className="space-y-1.5">
        <label htmlFor="campaign-name" className="text-xs font-medium text-text-muted">
          Campaign name
        </label>
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vitalcap - Maps Fast" />
      </div>
      <p className="text-xs text-text-muted">Offer: {offer?.name ?? "Default workspace offer (created automatically)"}</p>
      <div className="space-y-1.5">
        <label htmlFor="campaign-create-status" className="text-xs font-medium text-text-muted">Status</label>
        <Select id="campaign-create-status" value={status} onChange={(event) => setStatus(event.target.value as "active" | "draft")} className="w-full">
          <option value="active">Active</option>
          <option value="draft">Draft</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="campaign-create-autopilot" className="text-xs font-medium text-text-muted">Autopilot</label>
        <Select id="campaign-create-autopilot" value={String(autopilotEnabled)} onChange={(event) => setAutopilotEnabled(event.target.value === "true")} className="w-full">
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </Select>
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
      <p className="text-xs text-text-muted">Timezone: Europe/Madrid</p>
      {warning && <p className="text-xs text-warning" role="status">{warning}</p>}
      <div className="space-y-1.5">
        <label htmlFor="campaign-target" className="text-xs font-medium text-text-muted">
          Daily soft target
        </label>
        <Input
          id="campaign-target"
          type="number"
          min={1}
          max={250}
          value={dailySoftTarget}
          onChange={(e) => setDailySoftTarget(Number(e.target.value))}
        />
      </div>
      <details className="rounded-[10px] border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-text">Advanced JSON config (optional)</summary>
        <textarea
          className="mt-3 h-24 w-full rounded-[10px] border border-border bg-surface-muted p-2 text-xs text-text-muted"
          placeholder="{}"
          value={engineConfig}
          onChange={(event) => setEngineConfig(event.target.value)}
        />
      </details>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create campaign"}</Button>
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
            Active campaigns with Autopilot ON are scheduled by their selected engine when its provider is configured and healthy. Click a row to manage operational settings.
          </p>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>Campaign</TableHeadCell>
                <TableHeadCell>Engine</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Autopilot</TableHeadCell>
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
                      <Badge variant={STATUS_VARIANT[campaign.status]}>{STATUS_LABELS[campaign.status]}</Badge>
                    </TableCell>
                    <TableCell><Badge variant={campaign.autopilotEnabled ? "success" : "neutral"}>{campaign.autopilotEnabled ? "ON" : "OFF"}</Badge></TableCell>
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
        {selected ? <CampaignDetail key={selected.id} campaign={selected} data={data} onUpdated={setSelected} /> : null}
      </Sheet>

      <Sheet open={creating} onClose={() => setCreating(false)} title="New campaign" description="Guided setup — advanced config stays optional">
        <NewCampaignForm onClose={() => setCreating(false)} offer={data.offer} engineTargets={data.engineTargets} />
      </Sheet>
    </div>
  );
}
