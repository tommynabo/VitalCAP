import {
  getCampaigns,
  getConversations,
  getEngineTargets,
  getMeetings,
  getOffer,
  getOutreachQueueItems,
} from "@/lib/data/repository";
import { CampaignsClient } from "./campaigns-client";

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

