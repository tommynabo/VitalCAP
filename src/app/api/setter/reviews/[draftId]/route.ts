import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetterReviewItem, persistSetterReviewDecision, sendReviewedSetterReply } from "@/infrastructure/neon/repositories/setter-runtime";
import { insertAuditLog } from "@/infrastructure/neon/repositories/audit";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
import { getDeliveryEnv } from "@/lib/config/env";
import { applyReviewDecision } from "@/services/setter/review-service";
import { setterOutputSchema } from "@/services/setter/setter-output-schema";

export const dynamic = "force-dynamic";

const reviewCommandSchema = z.object({
  decision: z.enum(["approve", "edit_and_send", "reject", "take_over"]),
  finalText: z.string().max(10_000).nullable().optional(),
  correctionReason: z.string().max(500).nullable().optional(),
  correctedBranch: setterOutputSchema.shape.branch.nullable().optional(),
  note: z.string().max(1_000).nullable().optional(),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const context = await requireWorkspaceMember();
    let rawCommand: unknown;
    try {
      rawCommand = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid review request." }, { status: 400 });
    }
    const command = reviewCommandSchema.parse(rawCommand);
    const shouldSend = command.decision === "approve" || command.decision === "edit_and_send";
    if (shouldSend) {
      const deliveryEnv = getDeliveryEnv();
      if (deliveryEnv.EMAIL_DELIVERY_PROVIDER !== "instantly" || !deliveryEnv.INSTANTLY_API_KEY) {
        return NextResponse.json({ error: "Approved reply delivery is not configured.", errorCode: "INSTANTLY_REPLY_CONFIGURATION_ERROR" }, { status: 503 });
      }
    }
    const { draftId } = await params;
    const item = await getSetterReviewItem(context.workspaceId, draftId);
    if (!item) return NextResponse.json({ error: "Review item not found." }, { status: 404 });
    if (item.conversation.state !== "pending_review") {
      return NextResponse.json({ error: "This reply is no longer pending review." }, { status: 409 });
    }

    const result = applyReviewDecision({
      draft: item.draft,
      conversation: item.conversation,
      decision: command.decision,
      finalText: command.finalText ?? null,
      correctionReason: command.correctionReason ?? null,
      correctedBranch: command.correctedBranch ?? null,
      note: command.note ?? null,
      reviewerId: context.user.userId,
      reviewedAt: new Date().toISOString(),
    }, () => crypto.randomUUID());
    const saved = await persistSetterReviewDecision(context.workspaceId, item, result);
    if (!saved) return NextResponse.json({ error: "This reply was reviewed by another operator." }, { status: 409 });

    let delivery = "not_sent";
    let deliveryErrorCode: string | undefined;
    if (shouldSend) {
      const sendResult = await sendReviewedSetterReply(context.workspaceId, draftId);
      if (sendResult.status === "already_claimed") {
        return NextResponse.json({ state: "sending", delivery: "already_started" }, { status: 409 });
      }
      if (sendResult.status === "reconciliation_required") {
        await insertAuditLog({
          workspaceId: context.workspaceId,
          actorUserId: context.user.userId,
          action: `setter.review.${command.decision}`,
          entityType: "setter_draft",
          entityId: item.draft.id,
          metadata: { branch: item.draft.branch, correctedBranch: command.correctedBranch ?? null, delivery: sendResult.status },
        });
        return NextResponse.json({ state: "send_unknown", delivery: "reconciliation_required", errorCode: sendResult.errorCode }, { status: 409 });
      }
      if (sendResult.status === "sent") {
        delivery = "sent";
      } else {
        delivery = sendResult.status === "uncertain" ? "uncertain" : "failed";
        deliveryErrorCode = sendResult.errorCode;
      }
    }

    await insertAuditLog({
      workspaceId: context.workspaceId,
      actorUserId: context.user.userId,
      action: `setter.review.${command.decision}`,
      entityType: "setter_draft",
      entityId: item.draft.id,
      metadata: { branch: item.draft.branch, correctedBranch: command.correctedBranch ?? null },
    });
    const state = delivery === "sent" ? "sent" : delivery === "not_sent" ? result.conversation.state : delivery === "uncertain" ? "send_unknown" : "send_failed";
    return NextResponse.json({ state, delivery, ...(deliveryErrorCode ? { errorCode: deliveryErrorCode } : {}), feedback: result.feedback }, {
      status: delivery === "uncertain" ? 202 : delivery === "failed" ? 502 : 200,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid review decision." }, { status: 400 });
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    if (error instanceof Error && error.message === "edit_and_send requires finalText") {
      return NextResponse.json({ error: "Edited approval requires final text." }, { status: 400 });
    }
    if (error instanceof Error && error.message === "approve requires draft text") {
      return NextResponse.json({ error: "This draft is empty; use Edit & Send with reviewed text." }, { status: 400 });
    }
    return NextResponse.json({ error: "Review decision could not be saved." }, { status: 500 });
  }
}