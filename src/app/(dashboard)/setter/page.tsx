import {
  getAccountBundles,
  getConversationMessages,
  getConversations,
  getMeetings,
  getOffers,
  getCampaigns,
  getSetterDrafts,
  getSetterFeedback,
  getSetterWebhookEvents,
} from "@/lib/data/repository";
import { SetterClient } from "./setter-client";

export default async function SetterPage() {
  const [conversations, conversationMessages, meetings, setterDrafts, setterFeedback, accountBundles, campaigns, offers, webhookEvents] = await Promise.all([
    getConversations(),
    getConversationMessages(),
    getMeetings(),
    getSetterDrafts(),
    getSetterFeedback(),
    getAccountBundles(),
    getCampaigns(),
    getOffers(),
    getSetterWebhookEvents(),
  ]);

  return (
    <SetterClient
      conversations={conversations}
      conversationMessages={conversationMessages}
      meetings={meetings}
      setterDrafts={setterDrafts}
      setterFeedback={setterFeedback}
      accountBundles={accountBundles}
      campaigns={campaigns}
      offers={offers}
      webhookEvents={webhookEvents}
      renderedAt={new Date().toISOString()}
    />
  );
}
