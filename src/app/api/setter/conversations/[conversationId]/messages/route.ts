import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import { getSetterConversationHistoryForWorkspace } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

const cursorSchema = z.object({
  id: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
}).strict();

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const workspace = await requireWorkspaceMember();
    const { conversationId } = await context.params;
    const cursorValue = new URL(request.url).searchParams.get("cursor");
    const cursor = cursorValue ? cursorSchema.parse(JSON.parse(cursorValue)) : null;
    const page = await getSetterConversationHistoryForWorkspace(workspace.workspaceId, conversationId, cursor);
    if (!page) return jsonResponse({ error: "Conversation not found." }, 404);
    return jsonResponse(page);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return jsonResponse({ error: "Invalid conversation history cursor." }, 400);
    }
    if (error instanceof UnauthorizedError) {
      return jsonResponse({ error: "Workspace authorization required." }, 403);
    }
    return jsonResponse({ error: "Conversation history could not be loaded." }, 500);
  }
}