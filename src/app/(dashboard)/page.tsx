import { EngineCard } from "@/components/dashboard/engine-card";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { ActivityRail } from "@/components/dashboard/activity-rail";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { FunnelChart, MiniBarChart, MixBar } from "@/components/ui/charts";
import { globalProgressPct } from "@/lib/autopilot/targets";
import {
  getGlobalAutopilotStateData,
  getAccountBundles,
  getCampaigns,
  getConversations,
  getMeetings,
  getOutreachQueueItems,
  getWeeklyTrendData,
} from "@/lib/data/repository";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 19) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const [state, seedAccountBundles, seedCampaigns, seedConversations, seedMeetings, seedOutreachQueueItems, seedWeeklyTrend] =
    await Promise.all([
      getGlobalAutopilotStateData(),
      getAccountBundles(),
      getCampaigns(),
      getConversations(),
      getMeetings(),
      getOutreachQueueItems(),
      getWeeklyTrendData(),
    ]);
  const progressPct = globalProgressPct(state.dailyTarget, state.engines);

  const totalContactPoints = seedAccountBundles.reduce((sum, b) => sum + b.contactPoints.length, 0);
  const verifiedContactPoints = seedAccountBundles.reduce(
    (sum, b) => sum + b.contactPoints.filter((cp) => cp.verificationStatus === "valid").length,
    0,
  );
  const readyAccounts = seedAccountBundles.filter((b) => b.account.status === "outreach_ready").length;
  const sentOrBeyond = seedOutreachQueueItems.filter((q) => q.state === "sent" || q.state === "delivered").length;
  const funnelStages = [
    { label: "Accounts", value: seedAccountBundles.length },
    { label: "Contact points", value: totalContactPoints },
    { label: "Verified", value: verifiedContactPoints },
    { label: "Outreach ready", value: readyAccounts },
    { label: "Sent", value: sentOrBeyond },
    { label: "Replied", value: seedConversations.length },
    { label: "Meetings", value: seedMeetings.length },
  ];

  const emailCount = seedOutreachQueueItems.filter((q) => q.channel === "email").length;
  const smsCount = seedOutreachQueueItems.filter((q) => q.channel === "phone").length;

  const topCampaigns = seedCampaigns
    .map((campaign) => {
      const conversations = seedConversations.filter((c) => c.campaignId === campaign.id);
      const conversationIds = new Set(conversations.map((c) => c.id));
      const meetings = seedMeetings.filter((m) => conversationIds.has(m.conversationId)).length;
      return { campaign, replies: conversations.length, meetings };
    })
    .filter((row) => row.replies > 0)
    .sort((a, b) => b.meetings - a.meetings || b.replies - a.replies);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">{greeting()}</h2>
        <p className="text-sm text-text-muted">
          {new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })} · Autopilot
          status overview
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiStat label="Daily target" value={String(state.dailyTarget)} />
        <KpiStat label="Ready today" value={String(state.readyToday)} emphasize />
        <KpiStat label="Sent today" value={String(state.sentToday)} />
        <KpiStat label="Replies" value={String(state.repliesToday)} />
        <KpiStat label="Meetings" value={String(state.meetingsToday)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Autopilot progress</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-text">
              {state.readyToday} <span className="text-base font-normal text-text-muted">/ {state.dailyTarget}</span>
            </p>
            <Progress value={progressPct} className="mt-3" />
            <p className="mt-3 text-xs text-text-muted">
              Ready buffer: {state.readyBufferDays.toFixed(1)} days · System health:{" "}
              <span className="font-medium text-text">{state.systemHealth}</span>
            </p>
          </CardContent>
        </Card>

        <ActivityRail />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text">Discovery engines</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {state.engines.map((engine) => (
            <EngineCard key={engine.engineType} engine={engine} />
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Weekly reply / meeting trend</CardTitle>
          </CardHeader>
          <CardContent>
            <MiniBarChart data={seedWeeklyTrend.map((p) => ({ label: p.label, value: p.replies }))} />
            <p className="mt-3 text-xs text-text-muted">
              {seedWeeklyTrend.reduce((sum, p) => sum + p.meetings, 0)} meetings booked this week
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Channel mix</CardTitle>
          </CardHeader>
          <CardContent>
            <MixBar
              segments={[
                { label: "Email", value: emailCount, colorClassName: "bg-primary" },
                { label: "SMS", value: smsCount, colorClassName: "bg-warning" },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Discovery-to-meeting funnel</CardTitle>
          </CardHeader>
          <CardContent>
            <FunnelChart stages={funnelStages} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top campaign performance</CardTitle>
          </CardHeader>
          <CardContent>
            {topCampaigns.length === 0 ? (
              <p className="text-xs text-text-muted">No campaign has generated replies yet.</p>
            ) : (
              <ul className="space-y-3">
                {topCampaigns.map(({ campaign, replies, meetings }) => (
                  <li key={campaign.id} className="flex items-center justify-between text-sm">
                    <span className="text-text">{campaign.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge variant="neutral">{replies} replies</Badge>
                      <Badge variant="success">{meetings} meetings</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

