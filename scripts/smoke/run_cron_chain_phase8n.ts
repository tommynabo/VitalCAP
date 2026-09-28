export {};
import { runAutopilotCronTick } from "@/infrastructure/jobs/runners/autopilot-runner";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";

async function main() {
  console.log("=== CYCLE 1 ===");
  console.log("1. Running Autopilot Cron...");
  const autopilotRes1 = await runAutopilotCronTick();
  console.log("Autopilot Result:", JSON.stringify(autopilotRes1, null, 2));

  console.log("\n2. Running Discovery Cron...");
  const discoveryRes1 = await runDiscoveryCronTick(5);
  console.log("Discovery Result:", JSON.stringify(discoveryRes1, null, 2));

  console.log("\n3. Running Provider Runs Cron (Waiting 15 seconds to allow Apify Actor to start)...");
  await new Promise(resolve => setTimeout(resolve, 15000));
  const providerRes1 = await runProviderRunsCronTick();
  console.log("Provider Runs Result:", JSON.stringify(providerRes1, null, 2));

  console.log("\n4. Running Processing Cron...");
  const processRes1 = await runProcessingCronTick(5);
  console.log("Processing Result:", JSON.stringify(processRes1, null, 2));

  console.log("\n=== CYCLE 2 (Testing no duplicate orders) ===");
  console.log("1. Running Autopilot Cron...");
  const autopilotRes2 = await runAutopilotCronTick();
  console.log("Autopilot Result:", JSON.stringify(autopilotRes2, null, 2));
}

main().catch(console.error);
