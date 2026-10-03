"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FilePenLine, Hand, X } from "lucide-react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeBranchPerformance, computeSetterAnalytics } from "@/services/setter/feedback-analytics";
import type { Conversation, ConversationMessage, Meeting, SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import type { AccountBundle } from "@/lib/data/repository";

/**
 * AI Setter dashboard (Prompt 4 §4.11). KPI row (pending review, approved
 * today, edited today, rejected, meetings generated, branch accuracy,
 * response latency) plus a branch performance table, computed from the
 * shared `feedback-analytics.ts` service so this page and any future
 * reporting surface never re-derive the same numbers twice.
 */
export function SetterClient({
  conversations,
  conversationMessages,
  meetings,
  setterDrafts,
  setterFeedback,
  accountBundles,
}: {
  conversations: Conversation[];
  conversationMessages: ConversationMessage[];
  meetings: Meeting[];
  setterDrafts: SetterDraft[];
  setterFeedback: SetterFeedback[];
  accountBundles: AccountBundle[];
}) {
  const router = useRouter();
  const [editedDrafts, setEditedDrafts] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const analytics = useMemo(
    () =>
      computeSetterAnalytics({
        feedback: setterFeedback,
        drafts: setterDrafts,
        meetingsBookedCount: meetings.length,
      }),
    [setterFeedback, setterDrafts, meetings],
  );

  const branchPerformance = useMemo(() => computeBranchPerformance(setterFeedback, setterDrafts), [setterFeedback, setterDrafts]);

  const pendingReview = conversations.filter((conversation) => conversation.state === "pending_review").length;
  const messageById = new Map(conversationMessages.map((message) => [message.id, message]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const accountBundleById = new Map(accountBundles.map((bundle) => [bundle.account.id, bundle]));
  const pendingDrafts = setterDrafts.filter((draft) => {
    const message = messageById.get(draft.conversationMessageId);
    const conversation = message ? conversationById.get(message.conversationId) : null;
    return message?.direction === "incoming" && conversation?.state === "pending_review";
  });

  async function submitReview(draft: SetterDraft, decision: "approve" | "edit_and_send" | "reject" | "take_over") {
    setBusyDraftId(draft.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/setter/reviews/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          finalText: decision === "edit_and_send" ? editedDrafts[draft.id] ?? draft.draft : null,
          note: reviewNotes[draft.id] ?? null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Review decision could not be saved.");
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Review decision could not be saved.");
    } finally {
      setBusyDraftId(null);
    }
  }
  const approvedToday = setterFeedback.filter((feedback) => feedback.decision === "approve").length;
  const editedToday = setterFeedback.filter((feedback) => feedback.decision === "edit_and_send").length;
  const rejectedToday = setterFeedback.filter((feedback) => feedback.decision === "reject").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text">AI Setter</h1>
        <Badge variant="primary">Human review</Badge>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Pending review" value={String(pendingReview)} emphasize />
        <KpiStat label="Approved today" value={String(approvedToday)} />
        <KpiStat label="Edited today" value={String(editedToday)} />
        <KpiStat label="Rejected today" value={String(rejectedToday)} />
        <KpiStat label="Meetings generated" value={String(meetings.length)} />
        <KpiStat label="Branch accuracy" value={`${Math.round(analytics.branchAccuracy * 100)}%`} />
      </div>

      <section className="space-y-3" aria-labelledby="setter-review-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="setter-review-heading" className="text-base font-semibold text-text">Review queue</h2>
          <span className="text-sm text-text-muted">{pendingDrafts.length} pending</span>
        </div>
        {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
        {pendingDrafts.length === 0 ? (
          <p className="border-t border-border py-5 text-sm text-text-muted">No replies are waiting for review.</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {pendingDrafts.map((draft) => {
              const message = messageById.get(draft.conversationMessageId);
              const conversation = message ? conversationById.get(message.conversationId) : null;
              const bundle = conversation ? accountBundleById.get(conversation.accountId) : null;
              const contact = bundle?.contacts.find((item) => item.id === conversation?.contactId) ?? null;
              const contactPoint = bundle?.contactPoints.find((point) => point.contactId === contact?.id && point.type === "email")
                ?? bundle?.contactPoints.find((point) => point.type === "email");
              if (!message || !conversation) return null;

              return (
                <article key={draft.id} className="grid min-w-0 gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)]">
                  <div className="min-w-0 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{bundle?.account.canonicalName ?? "Unknown account"}</span>
                      <Badge variant="primary">{draft.branch}</Badge>
                      <span className="text-xs text-text-muted">{Math.round(draft.confidence * 100)}% confidence</span>
                    </div>
                    <div className="space-y-1 text-sm text-text-muted">
                      <p>{contact?.fullName ?? contact?.firstName ?? "Contact not identified"}{contact?.jobTitle ? ` · ${contact.jobTitle}` : ""}</p>
                      <p className="break-all">{contactPoint?.value ?? ""}</p>
                      <p>{[bundle?.account.city, bundle?.account.province].filter(Boolean).join(", ")}</p>
                    </div>
                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">Incoming message</h3>
                      <p className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-3 text-sm text-text">{message.body}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                      <span>Intent: {draft.intentSummary}</span>
                      {bundle?.sources[0] && <span>Source: {bundle.sources[0].sourceType}</span>}
                    </div>
                  </div>

                  <div className="min-w-0 space-y-3">
                    <div>
                      <label htmlFor={`draft-${draft.id}`} className="mb-1 block text-xs font-semibold uppercase text-text-muted">AI draft</label>
                      <textarea
                        id={`draft-${draft.id}`}
                        value={editedDrafts[draft.id] ?? draft.draft}
                        onChange={(change) => setEditedDrafts((current) => ({ ...current, [draft.id]: change.target.value }))}
                        rows={5}
                        maxLength={10_000}
                        className="w-full resize-y rounded-md border border-border bg-surface p-3 text-sm text-text outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-text-muted">Risk</span>
                      {draft.riskFlags.length === 0 ? <Badge variant="success">None</Badge> : draft.riskFlags.map((flag) => <Badge key={flag} variant="danger">{flag}</Badge>)}
                    </div>
                    {draft.reasonForHuman && <p className="text-sm text-text-muted">{draft.reasonForHuman}</p>}
                    <input
                      value={reviewNotes[draft.id] ?? ""}
                      onChange={(change) => setReviewNotes((current) => ({ ...current, [draft.id]: change.target.value }))}
                      maxLength={1_000}
                      aria-label="Review note"
                      placeholder="Review note"
                      className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "approve")}>
                        <Check size={15} aria-hidden="true" /> Approve
                      </Button>
                      <Button size="sm" variant="secondary" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "edit_and_send")}>
                        <FilePenLine size={15} aria-hidden="true" /> Edit &amp; approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "reject")}>
                        <X size={15} aria-hidden="true" /> Reject
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "take_over")}>
                        <Hand size={15} aria-hidden="true" /> Take over
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Branch performance</CardTitle>
        </CardHeader>
        <CardContent>
          {branchPerformance.length === 0 ? (
            <p className="text-sm text-text-muted">No reviewed drafts yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-text-muted">
                  <th className="pb-2">Branch</th>
                  <th className="pb-2">Count</th>
                  <th className="pb-2">Accuracy</th>
                  <th className="pb-2">Avg. confidence</th>
                </tr>
              </thead>
              <tbody>
                {branchPerformance.map((row) => (
                  <tr key={row.branch} className="border-t border-border">
                    <td className="py-2">
                      <Badge variant="primary">{row.branch}</Badge>
                    </td>
                    <td className="py-2 text-text">{row.count}</td>
                    <td className="py-2 text-text">{Math.round(row.accuracy * 100)}%</td>
                    <td className="py-2 text-text">{Math.round(row.averageConfidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
