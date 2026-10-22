import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetterReviewItem, persistSetterReviewDecision, sendReviewedSetterReply } from "@/infrastructure/neon/repositories/setter-runtime";
import { insertAuditLog } from "@/infrastructure/neon/repositories/audit";
import { requireWorkspaceMember, UnauthorizedError } from "@/lib/auth/workspace";
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
    const { draftId } = await params;
    const item = await getSetterReviewItem(context.workspaceId, draftId);
    if (!item) return NextResponse.json({ error: "Review item not found." }, { status: 404 });
    if (item.conversation.state !== "pending_review") {
      if (item.conversation.state === "approved_pending_send"
        && (command.decision === "approve" || command.decision === "edit_and_send")) {
        const delivery = await sendReviewedSetterReply(context.workspaceId, draftId);
        const deliveryStatus = delivery.status === "accepted" ? "accepted"
          : delivery.status === "failed" ? "failed"
            : delivery.status === "uncertain" || delivery.status === "reconciliation_required" ? "uncertain"
              : "already_claimed";
        const state = deliveryStatus === "accepted" ? "send_accepted"
          : deliveryStatus === "failed" ? "send_failed"
            : deliveryStatus === "uncertain" ? "send_unknown" : "sending";
        return NextResponse.json({
          state,
          delivery: {
            status: deliveryStatus,
            ...(delivery.status === "failed" || delivery.status === "uncertain" || delivery.status === "reconciliation_required"
              ? { errorCode: delivery.errorCode }
              : {}),
            ...(delivery.status === "accepted" && delivery.providerMessageId ? { providerMessageId: delivery.providerMessageId } : {}),
          },
        });
      }
      const messageMetadata = item.message.metadata;
      const deliveryMetadata = messageMetadata.replyDelivery !== null && typeof messageMetadata.replyDelivery === "object"
        ? messageMetadata.replyDelivery as Record<string, unknown>
        : {};
      const existingStatus = item.conversation.state === "send_accepted" ? "accepted"
        : item.conversation.state === "sent" ? "sent"
          : item.conversation.state === "send_failed" ? "failed"
            : item.conversation.state === "send_unknown" ? "uncertain"
              : item.conversation.state === "sending" ? "already_claimed" : "not_sent";
      return NextResponse.json({
        state: item.conversation.state,
        delivery: {
          status: existingStatus,
          ...(existingStatus === "failed" || existingStatus === "uncertain"
            ? { errorCode: typeof deliveryMetadata.errorCode === "string" ? deliveryMetadata.errorCode : "DELIVERY_STATE_RECORDED" }
            : {}),
          ...(typeof deliveryMetadata.providerMessageId === "string" ? { providerMessageId: deliveryMetadata.providerMessageId } : {}),
        },
      });
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

    await insertAuditLog({
      workspaceId: context.workspaceId,
      actorUserId: context.user.userId,
      action: `setter.review.${command.decision}`,
      entityType: "setter_draft",
      entityId: item.draft.id,
      metadata: { branch: item.draft.branch, correctedBranch: command.correctedBranch ?? null },
    });
    if (command.decision !== "approve" && command.decision !== "edit_and_send") {
      return NextResponse.json({
        state: result.conversation.state,
        delivery: { status: "not_sent" },
        feedback: result.feedback,
      });
    }

    const delivery = await sendReviewedSetterReply(context.workspaceId, draftId);
    const auditAction = delivery.status === "failed"
        ? "setter.reply.failed"
        : delivery.status === "uncertain" || delivery.status === "reconciliation_required"
          ? "setter.reply.uncertain"
          : delivery.status === "already_claimed"
            ? null
            : "setter.reply.accepted";
    if (auditAction) {
      await insertAuditLog({
        workspaceId: context.workspaceId,
        actorUserId: context.user.userId,
        action: auditAction,
        entityType: "setter_draft",
        entityId: item.draft.id,
        metadata: {
          deliveryStatus: delivery.status,
          ...(delivery.status === "failed" || delivery.status === "uncertain" || delivery.status === "reconciliation_required"
            ? { errorCode: delivery.errorCode }
            : {}),
        },
      });
    }
    const status = delivery.status === "accepted"
      ? "accepted"
      : delivery.status === "failed"
        ? "failed"
        : delivery.status === "uncertain" || delivery.status === "reconciliation_required"
          ? "uncertain"
          : delivery.status === "already_claimed"
            ? "already_claimed"
            : "accepted";
    const state = delivery.status === "accepted"
      ? "send_accepted"
      : delivery.status === "failed"
        ? "send_failed"
        : delivery.status === "uncertain" || delivery.status === "reconciliation_required"
          ? "send_unknown"
          : delivery.status === "already_claimed"
            ? "sending"
            : result.conversation.state;
    return NextResponse.json({
      state,
      delivery: {
        status,
        ...(delivery.status === "failed" || delivery.status === "uncertain" || delivery.status === "reconciliation_required"
          ? { errorCode: delivery.errorCode }
          : {}),
        ...(delivery.status === "accepted" && delivery.providerMessageId ? { providerMessageId: delivery.providerMessageId } : {}),
      },
      feedback: result.feedback,
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