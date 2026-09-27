import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/env";
import { IntelligenceQueueProcessor } from "@/services/intelligence/queue-processor";
import { getDb, schema } from "@/infrastructure/neon/db";
import { eq } from "drizzle-orm";

export const maxDuration = 300; // 5 minutes max
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const env = getServerEnv();
  const authHeader = request.headers.get("authorization");
  
  if (env.APP_ENV === "production" && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const processor = new IntelligenceQueueProcessor();
  const db = getDb();
  
  // Create cron run
  const [cronRun] = await db.insert(schema.cronRuns).values({
    route: "/api/cron/intelligence",
    status: "running",
  }).returning();

  if (!cronRun) return NextResponse.json({ error: "Failed to start cron run" }, { status: 500 });

  try {
    const processedCount = await processor.processBatch();

    await db.update(schema.cronRuns)
      .set({
        status: "success",
        itemsProcessed: processedCount,
        finishedAt: new Date(),
      })
      .where(eq(schema.cronRuns.id, cronRun.id));

    return NextResponse.json({
      success: true,
      processed: processedCount,
    });
  } catch (error: any) {
    await db.update(schema.cronRuns)
      .set({
        status: "failed",
        error: error.message,
        finishedAt: new Date(),
      })
      .where(eq(schema.cronRuns.id, cronRun.id));
      
    return NextResponse.json({
      success: false,
      error: error.message,
    }, { status: 500 });
  }
}
