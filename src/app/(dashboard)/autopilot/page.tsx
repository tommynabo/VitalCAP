import {
  getGlobalAutopilotStateData,
  getDeadLetterSamplesData,
  getProviderRowsData,
  getQueueHealthData,
  getRebalanceDecisions,
} from "@/lib/data/repository";
import { AutopilotClient } from "./autopilot-client";

export default async function AutopilotPage() {
  const [state, deadLetterSamples, providerRows, queueHealth, rebalanceDecisions] = await Promise.all([
    getGlobalAutopilotStateData(),
    getDeadLetterSamplesData(),
    getProviderRowsData(),
    getQueueHealthData(),
    getRebalanceDecisions(),
  ]);

  return (
    <AutopilotClient
      state={state}
      deadLetterSamples={deadLetterSamples}
      providerRows={providerRows}
      queueHealth={queueHealth}
      rebalanceDecisions={rebalanceDecisions}
    />
  );
}

