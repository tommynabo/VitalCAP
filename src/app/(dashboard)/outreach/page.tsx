import {
  getAccountBundles,
  getCampaigns,
  getMailboxes,
  getOutreachEvents,
  getOutreachQueueItems,
  getSendingDomains,
} from "@/lib/data/repository";
import { OutreachClient } from "./outreach-client";

export default async function OutreachPage() {
  const [accountBundles, campaigns, mailboxes, outreachEvents, outreachQueueItems, sendingDomains] = await Promise.all([
    getAccountBundles(),
    getCampaigns(),
    getMailboxes(),
    getOutreachEvents(),
    getOutreachQueueItems(),
    getSendingDomains(),
  ]);

  return (
    <OutreachClient
      accountBundles={accountBundles}
      campaigns={campaigns}
      mailboxes={mailboxes}
      outreachEvents={outreachEvents}
      outreachQueueItems={outreachQueueItems}
      sendingDomains={sendingDomains}
    />
  );
}

