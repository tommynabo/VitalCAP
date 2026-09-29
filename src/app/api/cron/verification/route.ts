import { NextResponse } from "next/server";
import { getCoreEnv } from "@/lib/config/env";
import { runVerificationCronTick, enqueueVerificationJobs } from "@/infrastructure/jobs/runners/verification-runner";

export async function GET(request: Request) {
  try {
    const env = getCoreEnv();
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");

    if (env.APP_ENV === "production" && secret !== env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1. Enqueue new jobs for analyzed-qualified accounts
    const enqueued = await enqueueVerificationJobs();

    // 2. Process pending jobs
    // We pass 50 as a bounded batch size per tick
    const result = await runVerificationCronTick(50);

    return NextResponse.json({
      success: true,
      enqueued,
      jobsClaimed: result.jobsClaimed,
      emailsVerified: result.emailsVerified,
    });
  } catch (error) {
    console.error("Verification cron error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
