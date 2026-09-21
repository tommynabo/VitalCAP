import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FunnelChart } from "@/components/ui/charts";
import {
  seedAccountBundles,
  seedCampaigns,
  seedConversations,
  seedMeetings,
  seedOutreachQueueItems,
} from "@/lib/seed/dev-seed";

const ENGINE_LABELS: Record<string, string> = {
  maps_fast: "Maps Fast",
  maps_deep: "Maps Deep",
  google_serp: "Google SERP",
  linkedin_owner: "LinkedIn Owner",
  hybrid_fill: "Hybrid Fill",
};

// Proxy for "positive" reply intent — no dedicated sentiment field exists yet,
// so a conversation counts as positive if its latest classified intent is one
// of these commercially-positive branches.
const POSITIVE_BRANCHES = new Set(["INTEREST", "MEETING_REQUEST", "SAMPLES", "FORWARD_TO_PURCHASING"]);

function groupCount<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0) || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-text-muted">No data.</p>
        ) : (
          rows
            .sort((a, b) => b.value - a.value)
            .map((row) => (
              <div key={row.label} className="flex items-center justify-between text-xs">
                <span className="text-text-muted">{row.label}</span>
                <span className="font-medium text-text">
                  {row.value} <span className="text-text-muted">({Math.round((row.value / total) * 100)}%)</span>
                </span>
              </div>
            ))
        )}
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const accounts = seedAccountBundles.map((b) => b.account);
  const allContactPoints = seedAccountBundles.flatMap((b) => b.contactPoints);
  const allContacts = seedAccountBundles.flatMap((b) => b.contacts);

  const totalRaw = accounts.length;
  const totalContactPoints = allContactPoints.length;
  const verified = allContactPoints.filter((cp) => cp.verificationStatus === "valid").length;
  const readyAccounts = accounts.filter((a) => a.status === "outreach_ready").length;
  const sent = seedOutreachQueueItems.filter((q) => q.state === "sent" || q.state === "delivered").length;
  const replies = seedConversations.length;
  const positive = seedConversations.filter((c) => c.latestIntent && POSITIVE_BRANCHES.has(c.latestIntent)).length;
  const meetings = seedMeetings.length;

  const funnelStages = [
    { label: "Raw discovered", value: totalRaw },
    { label: "Unique contact points", value: totalContactPoints },
    { label: "Verified", value: verified },
    { label: "Outreach ready", value: readyAccounts },
    { label: "Sent", value: sent },
    { label: "Replied", value: replies },
    { label: "Positive", value: positive },
    { label: "Meeting booked", value: meetings },
  ];

  const replyRate = sent > 0 ? Math.round((replies / sent) * 100) : 0;
  const positiveRate = replies > 0 ? Math.round((positive / replies) * 100) : 0;
  const meetingRate = replies > 0 ? Math.round((meetings / replies) * 100) : 0;
  const enrichmentYield = totalRaw > 0 ? Math.round((totalContactPoints / totalRaw) * 100) : 0;
  const verificationYield = totalContactPoints > 0 ? Math.round((verified / totalContactPoints) * 100) : 0;

  const byEngine = groupCount(
    seedConversations,
    (c) => {
      const campaign = seedCampaigns.find((camp) => camp.id === c.campaignId);
      return campaign ? (ENGINE_LABELS[campaign.engineType] ?? campaign.engineType) : "unknown";
    },
  );
  const byCampaign = groupCount(seedConversations, (c) => seedCampaigns.find((camp) => camp.id === c.campaignId)?.name ?? "unknown");
  const byBusinessType = groupCount(accounts, (a) => a.businessType.replace(/_/g, " "));
  const byProvince = groupCount(accounts, (a) => a.province ?? "unknown");
  const byChannel = groupCount(seedOutreachQueueItems, (q) => q.channel);
  const byContactType = groupCount(allContactPoints, (cp) => (cp.isGeneric ? "Generic endpoint" : "Named person"));
  const byOwnerVsRole = groupCount(allContacts, (c) => (c.roleType === "owner" || c.roleType === "titular_pharmacist" ? "Owner" : "Other role"));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Analytics</h2>
        <p className="text-sm text-text-muted">
          Discovery-to-meeting funnel and breakdowns across every dimension that matters — engine, campaign,
          business type, province, channel and contact type. There is deliberately no single &quot;best engine&quot;
          score: engines serve different geographies and yield profiles, and ranking them on one number would
          hide that trade-off.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Badge variant="neutral">Reply rate {replyRate}%</Badge>
        <Badge variant="neutral">Positive rate {positiveRate}%</Badge>
        <Badge variant="neutral">Meeting rate {meetingRate}%</Badge>
        <Badge variant="neutral">Enrichment yield {enrichmentYield}%</Badge>
        <Badge variant="neutral">Verification yield {verificationYield}%</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Discovery-to-meeting funnel</CardTitle>
        </CardHeader>
        <CardContent>
          <FunnelChart stages={funnelStages} />
          <p className="mt-3 text-xs text-text-muted">
            Cost-per-ready-lead and per-provider spend are not shown — this demo has no connected billing/provider
            cost data. Wire real provider invoices to compute those once available.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <BreakdownTable title="By engine" rows={Object.entries(byEngine).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="By campaign" rows={Object.entries(byCampaign).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="By business type" rows={Object.entries(byBusinessType).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="By province" rows={Object.entries(byProvince).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="By channel" rows={Object.entries(byChannel).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="Generic vs named contact" rows={Object.entries(byContactType).map(([label, value]) => ({ label, value }))} />
        <BreakdownTable title="Owner vs role" rows={Object.entries(byOwnerVsRole).map(([label, value]) => ({ label, value }))} />
      </div>
    </div>
  );
}

