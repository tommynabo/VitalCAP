import { getSetterReviewQueuePage } from "@/lib/data/repository";
import { SetterClient } from "./setter-client";

export default async function SetterPage() {
  const initialQueuePage = await getSetterReviewQueuePage();

  return (
    <SetterClient
      initialQueuePage={initialQueuePage}
      renderedAt={new Date().toISOString()}
    />
  );
}
