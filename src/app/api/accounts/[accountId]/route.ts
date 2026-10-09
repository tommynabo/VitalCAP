import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import { getAccountBundleForWorkspace } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

const accountIdSchema = z.string().min(1).max(100);

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const workspace = await requireWorkspaceMember();
    const { accountId } = await context.params;
    const validAccountId = accountIdSchema.parse(accountId);
    const bundle = await getAccountBundleForWorkspace(workspace.workspaceId, validAccountId);
    if (!bundle) return jsonResponse({ error: "Account not found." }, 404);
    return jsonResponse(bundle);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonResponse({ error: "Invalid account id." }, 400);
    if (error instanceof UnauthorizedError) {
      return jsonResponse({ error: "Workspace authorization required." }, 403);
    }
    return jsonResponse({ error: "Account details could not be loaded." }, 500);
  }
}