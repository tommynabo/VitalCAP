import { NextRequest, NextResponse } from "next/server";
import { IntelligenceQueueProcessor } from "@/services/intelligence/queue-processor";
import { isAuthorizedCronRequest, runCronRoute, unauthorizedCronResponse } from "../_lib/cron-http";

export const maxDuration = 300; // 5 minutes max
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  return runCronRoute("/api/cron/intelligence", async () => {
    const batch = await new IntelligenceQueueProcessor().processBatch();
    return {
      itemsProcessed: batch.completed,
      metadata: {
        processed: batch.completed,
        claimed: batch.claimed,
        deferred: batch.deferred,
        failed: batch.failed,
      },
    };
  }, {
    formatResponse: (outcome) => {
      if (outcome.kind === "pilot_mode_active") {
        return NextResponse.json({ success: true, processed: 0, claimed: 0, deferred: 0, failed: 0, status: "pilot_mode_active" });
      }
      if (outcome.kind === "failed") {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        return NextResponse.json({ success: false, error: message }, { status: 500 });
      }
      return NextResponse.json({ success: true, ...outcome.result.metadata });
    },
  });
}
