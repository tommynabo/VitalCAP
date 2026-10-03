"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FilePenLine, Hand, X } from "lucide-react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeBranchPerformance, computeSetterAnalytics } from "@/services/setter/feedback-analytics";
import { computeSetterOperationsMetrics, requiresHumanIntervention } from "@/services/setter/operations-metrics";
import type { Campaign, Offer } from "@/domain/campaigns/types";
import type { Conversation, ConversationMessage, Meeting, SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import type { AccountBundle } from "@/lib/data/repository";
import type { SetterWebhookEventSummary } from "@/infrastructure/neon/repositories/setter-runtime";

type QueueMode = "all" | "human_required" | "high_risk" | "low_confidence" | "recent_inbound";
type AgeFilter = "any" | "1" | "4" | "24";

const REVIEW_REASONS = [
  "missing_commercial_fact",
  "incorrect_classification",
  "tone_or_clarity",
  "risk_or_compliance",
  "other",
];

function humanReason(draft: SetterDraft): string {
  const text = `${draft.reasonForHuman ?? ""} ${draft.riskFlags.join(" ")}`.toLowerCase();
  if (/config|api.?key/.test(text)) return "Configuration";
  if (/provider|timeout|rate.?limit|processing.?failure|unavailable/.test(text)) return "Provider failure";
  if (/invalid|schema|output|parse/.test(text)) return "Invalid model output";
  if (/commercial fact|missing fact|fact missing|approved.*fact|matching.*fact/.test(text)) return "Missing commercial fact";
  if (/guardrail|negotiation|claim|regulatory|certification|unsafe/.test(text)) return "Guardrail";
  if (draft.confidence < 0.6) return "Low confidence";
  return draft.reasonForHuman ? "Human review requested" : "Unknown";
}

function elapsedLabel(timestamp: string | null, now: number): string {
  if (!timestamp) return "—";
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;
}

function displayFact(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function relevantApprovedFacts(offer: Offer | undefined, draft: SetterDraft): string[] {
  if (!offer) return [];
  const terms = [draft.branch, ...draft.detectedFactsRequested]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñ]+/i)
    .filter((term) => term.length > 2);
  const factEntries = [
    ...Object.entries(offer.approvedCommercialFacts),
    ...Object.entries(offer.approvedProductFacts),
  ];
  const facts = factEntries.flatMap(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    if (!terms.some((term) => normalizedKey.includes(term))) return [];
    const displayed = displayFact(value);
    return displayed ? [`${key}: ${displayed}`] : [];
  });
  const claims = offer.approvedClaims.filter((claim) => terms.some((term) => claim.toLowerCase().includes(term)));
  return [...facts, ...claims.map((claim) => `Approved claim: ${claim}`)].slice(0, 8);
}

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
  campaigns,
  offers,
  webhookEvents,
  renderedAt,
}: {
  conversations: Conversation[];
  conversationMessages: ConversationMessage[];
  meetings: Meeting[];
  setterDrafts: SetterDraft[];
  setterFeedback: SetterFeedback[];
  accountBundles: AccountBundle[];
  campaigns: Campaign[];
  offers: Offer[];
  webhookEvents: SetterWebhookEventSummary[];
  renderedAt: string;
}) {
  const router = useRouter();
  const [editedDrafts, setEditedDrafts] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [queueMode, setQueueMode] = useState<QueueMode>("all");
  const [ageFilter, setAgeFilter] = useState<AgeFilter>("any");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
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

  const messageById = new Map(conversationMessages.map((message) => [message.id, message]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const accountBundleById = new Map(accountBundles.map((bundle) => [bundle.account.id, bundle]));
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const draftByMessageId = new Map(setterDrafts.map((draft) => [draft.conversationMessageId, draft]));
  const messagesByConversationId = new Map<string, ConversationMessage[]>();
  for (const message of conversationMessages) {
    const thread = messagesByConversationId.get(message.conversationId) ?? [];
    thread.push(message);
    messagesByConversationId.set(message.conversationId, thread);
  }
  for (const thread of messagesByConversationId.values()) {
    thread.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  const queueItems = conversations.flatMap((conversation) => {
    if (conversation.state !== "pending_review") return [];
    const thread = messagesByConversationId.get(conversation.id) ?? [];
    const incoming = [...thread].reverse().find((message) => message.direction === "incoming");
    const draft = incoming ? draftByMessageId.get(incoming.id) : null;
    return incoming && draft ? [{ conversation, message: incoming, draft }] : [];
  });
  const now = Date.parse(renderedAt);
  const visibleQueueItems = queueItems
    .filter(({ conversation, message, draft }) => {
      const ageHours = (now - Date.parse(message.createdAt)) / 3_600_000;
      if (queueMode === "human_required" && !requiresHumanIntervention(draft)) return false;
      if (queueMode === "high_risk" && draft.riskFlags.length === 0) return false;
      if (queueMode === "low_confidence" && draft.confidence >= 0.6) return false;
      if (queueMode === "recent_inbound" && ageHours > 24) return false;
      if (ageFilter !== "any" && ageHours < Number(ageFilter)) return false;
      if (campaignFilter !== "all" && conversation.campaignId !== campaignFilter) return false;
      if (accountFilter !== "all" && conversation.accountId !== accountFilter) return false;
      return true;
    })
    .sort((left, right) => {
      const priority = ({ draft, message }: (typeof queueItems)[number]) =>
        (draft.branch === "HUMAN_REQUIRED" || Boolean(draft.reasonForHuman) ? 100 : 0)
        + draft.riskFlags.length * 20
        + (draft.confidence < 0.6 ? 30 : 0)
        + Math.min(24, Math.max(0, (now - Date.parse(message.createdAt)) / 3_600_000));
      return priority(right) - priority(left) || Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt);
    });
  const operationsMetrics = computeSetterOperationsMetrics({
    pendingItems: queueItems.map(({ message }) => ({ messageCreatedAt: message.createdAt })),
    drafts: setterDrafts,
    feedback: setterFeedback,
    messageCreatedAtById: new Map(conversationMessages.map((message) => [message.id, message.createdAt])),
    webhookEvents,
  });
  const pendingDrafts = visibleQueueItems.map(({ draft }) => draft);

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
          correctionReason: reviewReasons[draft.id] ?? null,
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
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text">AI Setter</h1>
        <Badge variant="warning">Dry run · Auto-send off</Badge>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiStat label="Pending review" value={String(operationsMetrics.pendingCount)} emphasize />
        <KpiStat label="Oldest pending" value={elapsedLabel(operationsMetrics.oldestPendingAt, now)} />
        <KpiStat label="Avg. review" value={operationsMetrics.averageReviewMinutes === null ? "—" : `${Math.round(operationsMetrics.averageReviewMinutes)}m`} />
        <KpiStat label="Human required" value={operationsMetrics.humanRequiredRate === null ? "—" : `${Math.round(operationsMetrics.humanRequiredRate * 100)}%`} />
        <KpiStat label="Approval rate" value={operationsMetrics.approvalRate === null ? "—" : `${Math.round(operationsMetrics.approvalRate * 100)}%`} />
        <KpiStat label="Edit / reject" value={operationsMetrics.editRate === null || operationsMetrics.rejectRate === null
          ? "—"
          : `${Math.round(operationsMetrics.editRate * 100)}% / ${Math.round(operationsMetrics.rejectRate * 100)}%`} />
      </div>

      <section className="space-y-3" aria-labelledby="setter-review-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="setter-review-heading" className="text-base font-semibold text-text">Review queue</h2>
          <span className="text-sm text-text-muted">{visibleQueueItems.length} of {queueItems.length} pending · priority order</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs text-text-muted">
            Queue
            <select value={queueMode} onChange={(event) => setQueueMode(event.target.value as QueueMode)} className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text">
              <option value="all">Pending review</option>
              <option value="human_required">Human required</option>
              <option value="high_risk">High risk</option>
              <option value="low_confidence">Low confidence</option>
              <option value="recent_inbound">Recent inbound · 24h</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Campaign
            <select value={campaignFilter} onChange={(event) => setCampaignFilter(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text">
              <option value="all">All campaigns</option>
              {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Account
            <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text">
              <option value="all">All accounts</option>
              {accountBundles.map((bundle) => <option key={bundle.account.id} value={bundle.account.id}>{bundle.account.canonicalName}</option>)}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Minimum age / SLA
            <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value as AgeFilter)} className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text">
              <option value="any">Any age</option>
              <option value="1">Over 1 hour</option>
              <option value="4">Over 4 hours</option>
              <option value="24">Over 24 hours</option>
            </select>
          </label>
        </div>
        {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
        {visibleQueueItems.length === 0 ? (
          <p className="border-t border-border py-5 text-sm text-text-muted">No conversations match these filters.</p>
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
                      <p>Campaign: {campaignById.get(conversation.campaignId)?.name ?? "Unknown campaign"}</p>
                      <p>{contact?.fullName ?? contact?.firstName ?? "Contact not identified"}{contact?.jobTitle ? ` · ${contact.jobTitle}` : ""}</p>
                      <p className="break-all">{contactPoint?.value ?? ""}</p>
                    </div>
                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">Incoming message</h3>
                      <p className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-3 text-sm text-text">{message.body}</p>
                    </div>
                    <details className="border-t border-border pt-3">
                      <summary className="cursor-pointer text-xs font-medium text-text-muted">Conversation history ({(messagesByConversationId.get(conversation.id) ?? []).length})</summary>
                      <div className="mt-3 space-y-2">
                        {(messagesByConversationId.get(conversation.id) ?? []).map((threadMessage) => (
                          <div key={threadMessage.id} className={`rounded-md p-3 text-sm ${threadMessage.direction === "incoming" ? "bg-surface-muted text-text" : "border border-border text-text-muted"}`}>
                            <div className="mb-1 flex justify-between gap-3 text-xs">
                              <span>{threadMessage.direction === "incoming" ? "Contact" : "Prepared by Setter"}</span>
                              <time dateTime={threadMessage.createdAt}>{new Date(threadMessage.createdAt).toLocaleString()}</time>
                            </div>
                            <p className="whitespace-pre-wrap break-words">{threadMessage.body}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>

                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="primary">{draft.branch}</Badge>
                      <Badge variant={draft.confidence >= 0.8 ? "success" : draft.confidence >= 0.6 ? "warning" : "danger"}>{Math.round(draft.confidence * 100)}% confidence</Badge>
                      {requiresHumanIntervention(draft) && <Badge variant="danger">Human required · {humanReason(draft)}</Badge>}
                    </div>
                    <p className="text-sm text-text-muted">{draft.intentSummary}</p>
                    {draft.detectedFactsRequested.length > 0 && <p className="text-xs text-text-muted">Requested facts: {draft.detectedFactsRequested.join(", ")}</p>}
                    <div className="border-l-2 border-primary pl-3">
                      <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">Relevant approved facts</h3>
                      {relevantApprovedFacts(offerById.get(conversation.offerId), draft).length > 0 ? (
                        <ul className="space-y-1 text-sm text-text">
                          {relevantApprovedFacts(offerById.get(conversation.offerId), draft).map((fact) => <li key={fact}>{fact}</li>)}
                        </ul>
                      ) : <p className="text-sm text-text-muted">No matching approved facts.</p>}
                    </div>
                    <div>
                      <label htmlFor={`draft-${draft.id}`} className="mb-1 block text-xs font-semibold uppercase text-text-muted">Prepared reply · not sent</label>
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
                    {draft.reasonForHuman && <p className="text-sm text-danger">{draft.reasonForHuman}</p>}
                    <label className="block text-xs text-text-muted">
                      Review reason
                      <select
                        value={reviewReasons[draft.id] ?? ""}
                        onChange={(change) => setReviewReasons((current) => ({ ...current, [draft.id]: change.target.value }))}
                        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
                      >
                        <option value="">No correction reason</option>
                        {REVIEW_REASONS.map((reason) => <option key={reason} value={reason}>{reason.replaceAll("_", " ")}</option>)}
                      </select>
                    </label>
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

      <section className="space-y-3" aria-labelledby="setter-webhook-heading">
        <h2 id="setter-webhook-heading" className="text-base font-semibold text-text">Webhook observability</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <KpiStat label="Received" value={String(operationsMetrics.webhooks.received)} />
          <KpiStat label="Processed" value={String(operationsMetrics.webhooks.processed)} />
          <KpiStat label="Duplicate skipped" value={String(operationsMetrics.webhooks.duplicateSkipped)} />
          <KpiStat label="Human required" value={String(operationsMetrics.webhooks.humanRequired)} />
          <KpiStat label="Failed" value={String(operationsMetrics.webhooks.failed)} />
        </div>
        <div className="divide-y divide-border border-y border-border">
          {webhookEvents.slice(0, 10).map((event) => (
            <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={event.status === "failed" ? "danger" : event.status === "human_required" ? "warning" : "neutral"}>{event.status.replaceAll("_", " ")}</Badge>
                {event.errorCode && <span className="text-xs text-danger">{event.errorCode}</span>}
              </div>
              <time className="text-xs text-text-muted" dateTime={event.receivedAt}>{new Date(event.receivedAt).toLocaleString()}</time>
            </div>
          ))}
          {webhookEvents.length === 0 && <p className="py-4 text-sm text-text-muted">No webhook events recorded.</p>}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="setter-feedback-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="setter-feedback-heading" className="text-base font-semibold text-text">Review feedback</h2>
          <span className="text-sm text-text-muted">{setterFeedback.length} recorded</span>
        </div>
        <div className="divide-y divide-border border-y border-border">
          {[...setterFeedback].sort((left, right) => Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt)).slice(0, 10).map((feedback) => (
            <article key={feedback.id} className="grid gap-3 py-4 lg:grid-cols-[180px_1fr_1fr]">
              <div className="space-y-1 text-sm">
                <Badge variant="neutral">{feedback.decision.replaceAll("_", " ")}</Badge>
                <p className="text-xs text-text-muted">{feedback.reasonCategory ?? "No reason"}</p>
                <p className="text-xs text-text-muted">Reviewer {feedback.reviewerId}</p>
                <time className="block text-xs text-text-muted" dateTime={feedback.reviewedAt}>{new Date(feedback.reviewedAt).toLocaleString()}</time>
              </div>
              <div className="min-w-0">
                <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">AI original</h3>
                <p className="whitespace-pre-wrap break-words text-sm text-text">{feedback.aiDraft || "No AI draft"}</p>
              </div>
              <div className="min-w-0">
                <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">Human final</h3>
                <p className="whitespace-pre-wrap break-words text-sm text-text">{feedback.finalText ?? "No reply prepared"}</p>
                {feedback.note && <p className="mt-2 text-xs text-text-muted">{feedback.note}</p>}
              </div>
            </article>
          ))}
          {setterFeedback.length === 0 && <p className="py-4 text-sm text-text-muted">No reviews recorded.</p>}
        </div>
      </section>
    </div>
  );
}
