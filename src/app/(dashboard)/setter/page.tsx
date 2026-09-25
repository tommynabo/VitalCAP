import { getConversations, getMeetings, getSetterDrafts, getSetterFeedback } from "@/lib/data/repository";
import { SetterClient } from "./setter-client";

export default async function SetterPage() {
  const [conversations, meetings, setterDrafts, setterFeedback] = await Promise.all([
    getConversations(),
    getMeetings(),
    getSetterDrafts(),
    getSetterFeedback(),
  ]);

  return (
    <SetterClient
      conversations={conversations}
      meetings={meetings}
      setterDrafts={setterDrafts}
      setterFeedback={setterFeedback}
    />
  );
}
