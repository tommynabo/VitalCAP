import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import { getAccountListPageForWorkspace } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

const cursorSchema = z.object({
  id: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
}).strict();

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  try {
    const workspace = await requireWorkspaceMember();
    const cursorValue = new URL(request.url).searchParams.get("cursor");
    const cursor = cursorValue ? cursorSchema.parse(JSON.parse(cursorValue)) : null;
    const page = await getAccountListPageForWorkspace(workspace.workspaceId, cursor);
    return jsonResponse(page);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return jsonResponse({ error: "Invalid account page cursor." }, 400);
    }
    if (error instanceof UnauthorizedError) {
      return jsonResponse({ error: "Workspace authorization required." }, 403);
    }
    return jsonResponse({ error: "Accounts could not be loaded." }, 500);
  }
}