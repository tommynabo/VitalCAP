import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { seedCampaigns } from "@/lib/seed/dev-seed";

const ENGINE_LABELS: Record<string, string> = {
  maps_fast: "Maps Fast",
  maps_deep: "Maps Deep",
  google_serp: "Google SERP",
  linkedin_owner: "LinkedIn Owner",
  hybrid_fill: "Hybrid Fill",
};

export default function CampaignsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Campaign templates</CardTitle>
          <Badge variant="primary">Appendix D seed · disabled by default</Badge>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-text-muted">
            Five disabled campaign templates, one per discovery engine, ready to activate once provider
            credentials and campaign mappings are configured (Phase 2–3). Guided campaign creation and full
            campaign detail tabs ship in Phase 5.
          </p>
          <div className="overflow-x-auto rounded-[10px] border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-muted text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2">Campaign</th>
                  <th className="px-4 py-2">Engine</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Soft target</th>
                  <th className="px-4 py-2">Channel mix</th>
                </tr>
              </thead>
              <tbody>
                {seedCampaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium text-text">{campaign.name}</td>
                    <td className="px-4 py-2 text-text-muted">{ENGINE_LABELS[campaign.engineType]}</td>
                    <td className="px-4 py-2">
                      <Badge variant="neutral">{campaign.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-text-muted">{campaign.dailySoftTarget}</td>
                    <td className="px-4 py-2 text-text-muted">
                      {campaign.desiredChannelMix.email}% email / {campaign.desiredChannelMix.sms}% SMS
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
