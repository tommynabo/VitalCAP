import { NextResponse } from "next/server";
import { z } from "zod";
import { runInstantlyInboxReconcileTick } from "@/infrastructure/jobs/runners/instantly-inbox-reconcile-runner";
import { requireWorkspaceOwner, UnauthorizedError } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const reconcileSchema = z.object({
  lookbackHours: z.number().int().min(1).max(168).default(72),
  maxMessages: z.number().int().min(1).max(100).default(100),
}).strict();

export async function POST(request: Request) {
  try {
    const context = await requireWorkspaceOwner();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const input = reconcileSchema.parse(body);
    const result = await runInstantlyInboxReconcileTick({
      workspaceId: context.workspaceId,
      initialLookbackHours: input.lookbackHours,
      maxMessagesPerRun: input.maxMessages,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid reconciliation request." }, { status: 400 });
    return NextResponse.json({ error: "Instantly inbox reconciliation failed." }, { status: 500 });
  }
}
