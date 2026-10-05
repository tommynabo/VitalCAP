import {
  getGlobalAutopilotStateData,
  getAutopilotSettingsData,
  getDeadLetterSamplesData,
  getProviderRowsData,
  getQueueHealthData,
  getRebalanceDecisions,
  getLastCronRouteRunAtData,
  getInstantlyPipelineDiagnosticsData,
} from "@/lib/data/repository";
import { AutopilotClient } from "./autopilot-client";

// Autopilot is an operational console: its provider and queue state must
// always be read from Neon, never from a stale route cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AutopilotPage() {
  const [state, settings, deadLetterSamples, providerRows, queueHealth, rebalanceDecisions, lastAutopilotCron, lastDiscoveryCron, instantlyPipeline] = await Promise.all([
    getGlobalAutopilotStateData(),
    getAutopilotSettingsData(),
    getDeadLetterSamplesData(),
    getProviderRowsData(),
    getQueueHealthData(),
    getRebalanceDecisions(),
    getLastCronRouteRunAtData("autopilot"),
    getLastCronRouteRunAtData("discovery"),
    getInstantlyPipelineDiagnosticsData(),
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
      instantlyPipeline={instantlyPipeline}
    />
  );
}
