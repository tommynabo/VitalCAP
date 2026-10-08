import {
  getAccountBundles,
  getConversationMessages,
  getConversations,
  getCampaigns,
  getSetterDrafts,
} from "@/lib/data/repository";
import { SetterClient } from "./setter-client";

export default async function SetterPage() {
  const [conversations, conversationMessages, setterDrafts, accountBundles, campaigns] = await Promise.all([
    getConversations(),
    getConversationMessages(),
    getSetterDrafts(),
    getAccountBundles(),
    getCampaigns(),
  ]);

  return (
    <SetterClient
      conversations={conversations}
      conversationMessages={conversationMessages}
      setterDrafts={setterDrafts}
      accountBundles={accountBundles}
      campaigns={campaigns}
      renderedAt={new Date().toISOString()}
    />
  );
}
