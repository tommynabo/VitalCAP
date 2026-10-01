import {
  getCampaigns,
  getConversations,
  getEngineTargets,
  getMeetings,
  getOffer,
  getOutreachQueueItems,
} from "@/lib/data/repository";
import { CampaignsClient } from "./campaigns-client";

// Campaign controls must always reflect Neon after a save or browser reload.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CampaignsPage() {
  const [campaigns, conversations, engineTargets, meetings, offer, outreachQueueItems] = await Promise.all([
    getCampaigns(),
    getConversations(),
    getEngineTargets(),
    getMeetings(),
    getOffer(),
    getOutreachQueueItems(),
  ]);

  return (
    <CampaignsClient
      campaigns={campaigns}
      conversations={conversations}
      engineTargets={engineTargets}
      meetings={meetings}
      offer={offer}
      outreachQueueItems={outreachQueueItems}
    />
  );
}
