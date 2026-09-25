import {
  getAccountBundles,
  getCampaigns,
  getConversationMessages,
  getConversations,
  getSetterDrafts,
} from "@/lib/data/repository";
import { ReviewsClient } from "./reviews-client";

export default async function ReviewsPage() {
  const [accountBundles, campaigns, conversationMessages, conversations, setterDrafts] = await Promise.all([
    getAccountBundles(),
    getCampaigns(),
    getConversationMessages(),
    getConversations(),
    getSetterDrafts(),
  ]);

  return (
    <ReviewsClient
      accountBundles={accountBundles}
      campaigns={campaigns}
      conversationMessages={conversationMessages}
      conversations={conversations}
      setterDrafts={setterDrafts}
    />
  );
}
