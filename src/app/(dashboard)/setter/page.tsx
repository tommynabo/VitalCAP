import {
  getAccountBundles,
  getConversationMessages,
  getConversations,
  getMeetings,
  getSetterDrafts,
  getSetterFeedback,
} from "@/lib/data/repository";
import { SetterClient } from "./setter-client";

export default async function SetterPage() {
  const [conversations, conversationMessages, meetings, setterDrafts, setterFeedback, accountBundles] = await Promise.all([
    getConversations(),
    getConversationMessages(),
    getMeetings(),
    getSetterDrafts(),
    getSetterFeedback(),
    getAccountBundles(),
  ]);

  return (
    <SetterClient
      conversations={conversations}
      conversationMessages={conversationMessages}
      meetings={meetings}
      setterDrafts={setterDrafts}
      setterFeedback={setterFeedback}
      accountBundles={accountBundles}
    />
  );
}
