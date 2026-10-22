import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetterReviewItem, getSetterReviewSendDiagnostics, persistSetterReviewDecision, sendReviewedSetterReply } from "@/infrastructure/neon/repositories/setter-runtime";
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

export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const context = await requireWorkspaceMember();
    const { draftId } = await params;
    const diagnostics = await getSetterReviewSendDiagnostics(context.workspaceId, draftId);
    if (!diagnostics) return NextResponse.json({ error: "Review item not found." }, { status: 404 });
    return NextResponse.json(diagnostics);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Review diagnostics could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  let workspaceId: string | null = null;
  let draftIdForFailure: string | null = null;
  let failureStage = "REVIEW_LOOKUP";
  let persistedReviewState: string | null = null;
  let reviewPersisted = false;
  let deliveryResult: Awaited<ReturnType<typeof sendReviewedSetterReply>> | null = null;
  try {
    const context = await requireWorkspaceMember();
    workspaceId = context.workspaceId;
    let rawCommand: unknown;
    try {
      rawCommand = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid review request." }, { status: 400 });
    }
    const command = reviewCommandSchema.parse(rawCommand);
    const { draftId } = await params;
    draftIdForFailure = draftId;
    const item = await getSetterReviewItem(context.workspaceId, draftId);
    if (!item) return NextResponse.json({ error: "Review item not found." }, { status: 404 });
    if (item.conversation.state !== "pending_review") {
      if (item.conversation.state === "approved_pending_send"
        && (command.decision === "approve" || command.decision === "edit_and_send")) {
        reviewPersisted = true;
        persistedReviewState = item.conversation.state;
        failureStage = "SEND_CLAIM";
        const delivery = await sendReviewedSetterReply(context.workspaceId, draftId);
        deliveryResult = delivery;
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
    failureStage = "REVIEW_PERSIST";
    const saved = await persistSetterReviewDecision(context.workspaceId, item, result);
    if (!saved) return NextResponse.json({ error: "This reply was reviewed by another operator." }, { status: 409 });
    reviewPersisted = true;
    persistedReviewState = result.conversation.state;

    failureStage = "AUDIT_PERSIST";
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

    failureStage = "SEND_CLAIM";
    const delivery = await sendReviewedSetterReply(context.workspaceId, draftId);
    deliveryResult = delivery;
    const auditAction = delivery.status === "failed"
        ? "setter.reply.failed"
        : delivery.status === "uncertain" || delivery.status === "reconciliation_required"
          ? "setter.reply.uncertain"
          : delivery.status === "already_claimed"
            ? null
            : "setter.reply.accepted";
    if (auditAction) {
      failureStage = "OUTGOING_MESSAGE_FINALIZATION";
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
    if (!reviewPersisted && failureStage === "REVIEW_PERSIST") {
      return NextResponse.json({ error: "Review decision could not be saved.", errorCode: "REVIEW_PERSIST_FAILED" }, { status: 500 });
    }
    if (!reviewPersisted && failureStage === "REVIEW_LOOKUP") {
      return NextResponse.json({ error: "Review state could not be loaded.", errorCode: "REVIEW_LOOKUP_FAILED" }, { status: 500 });
    }
    if (reviewPersisted) {
      const currentItem = workspaceId && draftIdForFailure
        ? await getSetterReviewItem(workspaceId, draftIdForFailure).catch(() => null)
        : null;
      const state = currentItem?.conversation.state ?? persistedReviewState ?? "approved_pending_send";
      if (failureStage === "AUDIT_PERSIST") {
        return NextResponse.json({
          error: "Review saved, but its audit record could not be saved; no send was attempted.",
          state,
          delivery: { status: "not_sent", errorCode: "REVIEW_AUDIT_PERSIST_FAILED" },
        }, { status: 500 });
      }
      if (failureStage === "SEND_CLAIM") {
        const sendStarted = state !== "approved_pending_send";
        return NextResponse.json({
          error: sendStarted ? "Review saved; send outcome requires reconciliation." : "Review saved; sending could not be started.",
          state,
          delivery: sendStarted
            ? { status: "uncertain", errorCode: "SEND_OUTCOME_UNCERTAIN" }
            : { status: "failed", errorCode: "SEND_CLAIM_FAILED" },
        }, { status: 500 });
      }
      if (failureStage === "OUTGOING_MESSAGE_FINALIZATION" && deliveryResult) {
        const deliveryStatus = deliveryResult.status === "accepted" ? "accepted"
          : deliveryResult.status === "failed" ? "failed"
            : deliveryResult.status === "uncertain" || deliveryResult.status === "reconciliation_required" ? "uncertain"
              : "already_claimed";
        return NextResponse.json({
          error: "Reply state was saved, but its final audit record could not be saved.",
          state,
          delivery: {
            status: deliveryStatus,
            ...(deliveryResult.status === "failed" || deliveryResult.status === "uncertain" || deliveryResult.status === "reconciliation_required"
              ? { errorCode: deliveryResult.errorCode }
              : {}),
            ...(deliveryResult.status === "accepted" && deliveryResult.providerMessageId
              ? { providerMessageId: deliveryResult.providerMessageId }
              : {}),
          },
        }, { status: 500 });
      }
    }
    return NextResponse.json({ error: "Review request failed.", errorCode: "REVIEW_REQUEST_FAILED" }, { status: 500 });
  }
}