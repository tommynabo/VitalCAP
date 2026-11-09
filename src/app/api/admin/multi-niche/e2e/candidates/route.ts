import { NextResponse } from "next/server";
import { z } from "zod";
import { buildAdminScopedCandidateListQuery } from "@/infrastructure/neon/repositories/admin-scoped-e2e";
import { getDb } from "@/infrastructure/neon/db";
import { requireWorkspaceAdmin, UnauthorizedError } from "@/lib/auth/workspace";
import { MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS } from "@/services/autopilot/multi-niche-rollout";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  campaignId: z.uuid().optional(),
  stage: z.enum(["discovered", "qualified", "contact_selected", "ready", "rejected", "contacted"]).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
}).strict();

export async function GET(request: Request) {
  try {
    const auth = await requireWorkspaceAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid scoped candidate query." }, { status: 400 });
    }
    if (parsed.data.campaignId && !MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS.some((id) => id === parsed.data.campaignId)) {
      return NextResponse.json({ error: "Campaign ID is not allowlisted." }, { status: 403 });
    }

    const result = await getDb().execute(buildAdminScopedCandidateListQuery({
      workspaceId: auth.workspaceId,
      ...parsed.data,
    }));
    return NextResponse.json({ candidates: result.rows });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to list scoped candidates." }, { status: 500 });
  }
}