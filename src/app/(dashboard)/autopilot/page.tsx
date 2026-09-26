import {
  getGlobalAutopilotStateData,
  getAutopilotSettingsData,
  getDeadLetterSamplesData,
  getProviderRowsData,
  getQueueHealthData,
  getRebalanceDecisions,
  getLastCronRouteRunAtData,
} from "@/lib/data/repository";
import { AutopilotClient } from "./autopilot-client";

export default async function AutopilotPage() {
  const [state, settings, deadLetterSamples, providerRows, queueHealth, rebalanceDecisions, lastAutopilotCron, lastDiscoveryCron] = await Promise.all([
    getGlobalAutopilotStateData(),
    getAutopilotSettingsData(),
    getDeadLetterSamplesData(),
    getProviderRowsData(),
    getQueueHealthData(),
    getRebalanceDecisions(),
    getLastCronRouteRunAtData("autopilot"),
    getLastCronRouteRunAtData("discovery"),
  ]);

  return (
    <AutopilotClient
      state={state}
      settings={settings}
      lastAutopilotCron={lastAutopilotCron}
      lastDiscoveryCron={lastDiscoveryCron}
      deadLetterSamples={deadLetterSamples}
      providerRows={providerRows}
      queueHealth={queueHealth}
      rebalanceDecisions={rebalanceDecisions}
    />
  );
}

