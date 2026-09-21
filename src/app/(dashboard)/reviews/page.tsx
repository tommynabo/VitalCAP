"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  seedAccountBundles,
  seedCampaigns,
  seedConversationMessages,
  seedConversations,
  seedSetterDrafts,
} from "@/lib/seed/dev-seed";
import type { ConversationState, ReviewDecision } from "@/domain/conversations/types";

/**
 * Reviews inbox (Prompt 4 §4.10). Three-column desktop layout: conversation
 * list (left), thread (center), AI analysis + draft + controls (right).
 * Read-only over dev-seed data in this phase — review actions mirror
 * `applyReviewDecision`'s shape locally but do not persist (no DB yet).
 */

const STATE_VARIANT: Record<ConversationState, "success" | "warning" | "danger" | "neutral" | "primary"> = {
  reply_received: "primary",
  pre_routed: "primary",
  ai_classified: "primary",
  draft_ready: "primary",
  pending_review: "warning",
  approved: "success",
  edited: "success",
  rejected: "danger",
  escalated: "danger",
  sent: "success",
  no_reply_needed: "neutral",
  suppressed: "danger",
  meeting_booked: "success",
  human_owned: "neutral",
};

const REVIEW_ACTIONS: Array<{ decision: ReviewDecision; label: string; shortcut: string }> = [
  { decision: "approve", label: "Approve", shortcut: "A" },
  { decision: "edit_and_send", label: "Edit & Send", shortcut: "E" },
  { decision: "reject", label: "Reject", shortcut: "R" },
  { decision: "escalate", label: "Escalate", shortcut: "Esc" },
  { decision: "suppress", label: "Suppress", shortcut: "S" },
];

export default function ReviewsPage() {
  const accountsById = useMemo(() => new Map(seedAccountBundles.map((bundle) => [bundle.account.id, bundle.account])), []);
  const campaignsById = useMemo(() => new Map(seedCampaigns.map((campaign) => [campaign.id, campaign])), []);
  const draftsByMessageId = useMemo(() => new Map(seedSetterDrafts.map((draft) => [draft.conversationMessageId, draft])), []);
  const messagesByConversationId = useMemo(() => {
    const map = new Map<string, typeof seedConversationMessages>();
    for (const message of seedConversationMessages) {
      const existing = map.get(message.conversationId) ?? [];
      existing.push(message);
      map.set(message.conversationId, existing);
    }
    return map;
  }, []);

  const [selectedConversationId, setSelectedConversationId] = useState(seedConversations[0]?.id ?? null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null);

  const selectedConversation = seedConversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const thread = selectedConversation ? (messagesByConversationId.get(selectedConversation.id) ?? []) : [];
  const latestIncoming = [...thread].reverse().find((message) => message.direction === "incoming") ?? null;
  const draft = latestIncoming ? (draftsByMessageId.get(latestIncoming.id) ?? null) : null;
  const account = selectedConversation ? accountsById.get(selectedConversation.accountId) : null;
  const campaign = selectedConversation ? campaignsById.get(selectedConversation.campaignId) : null;

  const applyDecision = useCallback(
    (decision: ReviewDecision) => {
      const action = REVIEW_ACTIONS.find((a) => a.decision === decision);
      setLastAction(`${action?.label ?? decision} recorded for ${selectedConversation?.id ?? "conversation"} (dev-seed demo, not persisted).`);
      setPendingDecision(null);
    },
    [selectedConversation],
  );

  const goToNext = useCallback(() => {
    const index = seedConversations.findIndex((c) => c.id === selectedConversationId);
    const next = seedConversations[(index + 1) % seedConversations.length];
    if (next) setSelectedConversationId(next.id);
  }, [selectedConversationId]);

  // Keyboard shortcuts (Prompt 5 §5.11): A=approve, E=edit&send, R=reject,
  // S=suppress, N=next conversation. Approve/edit/reject/suppress require a
  // second keypress confirmation so an accidental key never triggers a send.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "n") {
        setPendingDecision(null);
        goToNext();
        return;
      }
      if (!draft) return;

      const map: Record<string, ReviewDecision> = { a: "approve", e: "edit_and_send", r: "reject", s: "suppress" };
      const decision = map[key];
      if (!decision) return;

      if (pendingDecision === decision) {
        applyDecision(decision);
      } else {
        setPendingDecision(decision);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draft, pendingDecision, applyDecision, goToNext]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Reviews</CardTitle>
          <Badge variant="primary">Prompt 4</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-muted">
            Every AI draft requires human review before sending (§4.7). Approve, edit, reject, escalate or suppress from the
            right-hand panel, or use keyboard shortcuts: <span className="font-medium text-text">A</span> approve ·{" "}
            <span className="font-medium text-text">E</span> edit & send · <span className="font-medium text-text">R</span> reject ·{" "}
            <span className="font-medium text-text">S</span> suppress · <span className="font-medium text-text">N</span> next. Press the
            same key twice to confirm — a single keypress never sends anything.
          </p>
          {lastAction ? <p className="mt-2 text-sm font-medium text-primary">{lastAction}</p> : null}
          {pendingDecision ? (
            <p className="mt-2 text-sm font-medium text-warning">
              Press {REVIEW_ACTIONS.find((a) => a.decision === pendingDecision)?.shortcut} again to confirm{" "}
              {REVIEW_ACTIONS.find((a) => a.decision === pendingDecision)?.label}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Conversations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {seedConversations.map((conversation) => {
              const conversationAccount = accountsById.get(conversation.accountId);
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    setSelectedConversationId(conversation.id);
                    setPendingDecision(null);
                  }}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                    conversation.id === selectedConversationId ? "border-primary bg-primary-soft" : "border-border bg-surface"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">{conversationAccount?.canonicalName ?? conversation.accountId}</span>
                    <Badge variant={STATE_VARIANT[conversation.state]}>{conversation.state}</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-text-muted">{conversation.latestIntent ?? "—"}</p>
                </button>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Thread</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {thread.length === 0 ? (
              <p className="text-sm text-text-muted">No messages yet.</p>
            ) : (
              thread.map((message) => (
                <div
                  key={message.id}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    message.direction === "incoming" ? "border-border bg-surface" : "ml-8 border-primary/40 bg-primary-soft"
                  }`}
                >
                  <p className="mb-1 text-xs font-medium text-text-muted">{message.direction === "incoming" ? "Lead" : "Vitalcap"}</p>
                  <p className="text-text">{message.body}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">AI analysis & draft</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs text-text-muted">
              <span>Account</span>
              <span className="text-right text-text">{account?.canonicalName ?? "—"}</span>
              <span>Campaign</span>
              <span className="text-right text-text">{campaign?.name ?? "—"}</span>
              <span>Source</span>
              <span className="text-right text-text">maps_fast</span>
            </div>

            {draft ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="primary">{draft.branch}</Badge>
                  <Badge variant={draft.confidence >= 0.8 ? "success" : draft.confidence >= 0.6 ? "warning" : "danger"}>
                    {Math.round(draft.confidence * 100)}% confidence
                  </Badge>
                  {draft.needsHuman ? <Badge variant="danger">needs human</Badge> : null}
                </div>

                {draft.riskFlags.length > 0 ? (
                  <div>
                    <p className="mb-1 text-xs font-medium text-text-muted">Risk flags</p>
                    <div className="flex flex-wrap gap-1">
                      {draft.riskFlags.map((flag) => (
                        <Badge key={flag} variant="danger">
                          {flag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div>
                  <p className="mb-1 text-xs font-medium text-text-muted">Draft reply</p>
                  <p className="rounded-md border border-border bg-surface px-3 py-2 text-text">{draft.draft}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {REVIEW_ACTIONS.map((action) => (
                    <button
                      key={action.decision}
                      type="button"
                      onClick={() => applyDecision(action.decision)}
                      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                        pendingDecision === action.decision
                          ? "border-warning bg-warning-soft text-warning"
                          : "border-border bg-surface text-text hover:bg-surface-muted"
                      }`}
                    >
                      {action.label} <span className="text-text-muted">({action.shortcut})</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-text-muted">No pending AI draft for this conversation.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
