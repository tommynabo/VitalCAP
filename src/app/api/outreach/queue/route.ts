import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import { getOutreachQueuePageDataForWorkspace } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

const tabSchema = z.enum(["scheduled", "sent", "replies", "failed", "suppressed"]);
const channelSchema = z.enum(["email", "phone", "linkedin", "other"]);
const cursorSchema = z.object({ id: z.string().min(1).max(100) }).strict();

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  try {
    const workspace = await requireWorkspaceMember();
    const searchParams = new URL(request.url).searchParams;
    const tab = tabSchema.parse(searchParams.get("tab"));
    const channel = searchParams.has("channel") ? channelSchema.parse(searchParams.get("channel")) : undefined;
    const campaignId = searchParams.get("campaignId") ?? undefined;
    const cursorValue = searchParams.get("cursor");
    const cursor = cursorValue ? cursorSchema.parse(JSON.parse(cursorValue)) : null;
    const page = await getOutreachQueuePageDataForWorkspace(workspace.workspaceId, tab, cursor, { channel, campaignId });
    return jsonResponse(page);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return jsonResponse({ error: "Invalid outreach queue page request." }, 400);
    }
    if (error instanceof UnauthorizedError) {
      return jsonResponse({ error: "Workspace authorization required." }, 403);
    }
    return jsonResponse({ error: "Outreach queue could not be loaded." }, 500);
  }
}