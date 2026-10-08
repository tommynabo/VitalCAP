import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetterReviewQueuePageForWorkspace } from "@/lib/data/repository";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import type { SetterQueueCursor } from "@/services/setter/review-queue";

export const dynamic = "force-dynamic";

const cursorSchema = z.object({
  id: z.string().min(1).max(100),
  updatedAt: z.string().datetime(),
}).strict();

export async function GET(request: Request) {
  try {
    const context = await requireWorkspaceMember();
    const cursorValue = new URL(request.url).searchParams.get("cursor");
    let cursor: SetterQueueCursor | null = null;
    if (cursorValue) cursor = cursorSchema.parse(JSON.parse(cursorValue));
    const page = await getSetterReviewQueuePageForWorkspace(context.workspaceId, cursor);
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid review queue cursor." }, { status: 400 });
    }
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Review queue could not be loaded." }, { status: 500 });
  }
}