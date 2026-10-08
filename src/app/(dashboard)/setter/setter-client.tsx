"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight, FilePenLine, X } from "lucide-react";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mergeSetterReviewQueuePages, type SetterReviewQueuePage } from "@/services/setter/review-queue";
import {
  mergeConversationHistoryPages,
  requestConversationHistoryOnExpand,
  type ConversationHistoryPage,
} from "@/services/setter/conversation-history";

function elapsedLabel(timestamp: string | null, now: number): string {
  if (!timestamp) return "—";
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;
}

/** Human review queue for incoming replies. */
export function SetterClient({
  initialQueuePage,
  renderedAt,
}: {
  initialQueuePage: SetterReviewQueuePage;
  renderedAt: string;
}) {
  const router = useRouter();
  const [additionalPage, setAdditionalPage] = useState<SetterReviewQueuePage | null>(null);
  const [editedDrafts, setEditedDrafts] = useState<Record<string, string>>({});
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [reviewedDraftIds, setReviewedDraftIds] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyByConversationId, setHistoryByConversationId] = useState<Record<string, ConversationHistoryPage>>({});
  const [historyLoadingIds, setHistoryLoadingIds] = useState<string[]>([]);
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
  const historyRequests = useRef(new Map<string, Promise<ConversationHistoryPage>>());

  const queuePage = additionalPage
    ? {
        ...mergeSetterReviewQueuePages(initialQueuePage, additionalPage),
        pendingCount: initialQueuePage.pendingCount,
        oldestPendingAt: initialQueuePage.oldestPendingAt,
      }
    : initialQueuePage;

  const { conversations, latestInboundMessages, messageCounts, setterDrafts, accountBundles, campaigns } = queuePage;
  const accountBundleById = new Map(accountBundles.map((bundle) => [bundle.account.id, bundle]));
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const draftByMessageId = new Map(setterDrafts.map((draft) => [draft.conversationMessageId, draft]));
  const latestInboundByConversationId = new Map(latestInboundMessages.map((message) => [message.conversationId, message]));
  const queueItems = conversations.flatMap((conversation) => {
    if (conversation.state !== "pending_review") return [];
    const incoming = latestInboundByConversationId.get(conversation.id);
    const draft = incoming ? draftByMessageId.get(incoming.id) : null;
    return incoming && draft ? [{ conversation, message: incoming, draft }] : [];
  });
  const now = Date.parse(renderedAt);
  const pendingItems = queueItems
    .filter(({ draft }) => !reviewedDraftIds.includes(draft.id))
    .sort((left, right) => Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt));

  async function fetchHistoryPage(conversationId: string, cursor: ConversationHistoryPage["nextCursor"] = null) {
    const query = cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : "";
    const response = await fetch(`/api/setter/conversations/${encodeURIComponent(conversationId)}/messages${query}`, { cache: "no-store" });
    const page = await response.json().catch(() => null) as ConversationHistoryPage | null;
    if (!response.ok || !page) throw new Error("No se pudo cargar el historial.");
    return page;
  }

  async function loadHistory(conversationId: string) {
    if (historyByConversationId[conversationId] || historyLoadingIds.includes(conversationId)) return;
    setHistoryLoadingIds((current) => [...current, conversationId]);
    setHistoryErrors((current) => ({ ...current, [conversationId]: "" }));
    try {
      const request = requestConversationHistoryOnExpand(true, conversationId, historyRequests.current, fetchHistoryPage);
      if (!request) return;
      const page = await request;
      setHistoryByConversationId((current) => ({ ...current, [conversationId]: page }));
    } catch (error) {
      setHistoryErrors((current) => ({ ...current, [conversationId]: error instanceof Error ? error.message : "No se pudo cargar el historial." }));
    } finally {
      setHistoryLoadingIds((current) => current.filter((id) => id !== conversationId));
    }
  }

  async function loadOlderHistory(conversationId: string) {
    const currentPage = historyByConversationId[conversationId];
    if (!currentPage?.nextCursor || historyLoadingIds.includes(conversationId)) return;
    setHistoryLoadingIds((current) => [...current, conversationId]);
    setHistoryErrors((current) => ({ ...current, [conversationId]: "" }));
    try {
      const olderPage = await fetchHistoryPage(conversationId, currentPage.nextCursor);
      setHistoryByConversationId((current) => ({
        ...current,
        [conversationId]: mergeConversationHistoryPages(current[conversationId] ?? currentPage, olderPage),
      }));
    } catch (error) {
      setHistoryErrors((current) => ({ ...current, [conversationId]: error instanceof Error ? error.message : "No se pudo cargar el historial." }));
    } finally {
      setHistoryLoadingIds((current) => current.filter((id) => id !== conversationId));
    }
  }

  async function loadMore(): Promise<SetterReviewQueuePage | null> {
    if (!queuePage.nextCursor || loadingMore) return null;
    setLoadingMore(true);
    setActionError(null);
    try {
      const query = new URLSearchParams({ cursor: JSON.stringify(queuePage.nextCursor) });
      const response = await fetch(`/api/setter/review-queue?${query.toString()}`);
      const nextPage = await response.json().catch(() => null) as SetterReviewQueuePage | null;
      if (!response.ok || !nextPage) throw new Error("No se pudieron cargar más conversaciones.");
      setAdditionalPage((current) => current ? mergeSetterReviewQueuePages(current, nextPage) : nextPage);
      return nextPage;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudieron cargar más conversaciones.");
      return null;
    } finally {
      setLoadingMore(false);
    }
  }

  async function submitReview(draft: (typeof setterDrafts)[number], decision: "approve" | "edit_and_send" | "reject") {
    setBusyDraftId(draft.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/setter/reviews/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          finalText: decision === "edit_and_send" ? editedDrafts[draft.id] ?? draft.draft : null,
          correctionReason: null,
          note: null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.state || result.delivery) router.refresh();
        throw new Error(result.error ?? result.errorCode ?? "Review decision could not be saved.");
      }
      setReviewedDraftIds((current) => [...current, draft.id]);
      setEditingDraftId(null);
      const nextDraft = pendingItems.find(({ draft: pendingDraft }) => pendingDraft.id !== draft.id)?.draft;
      if (nextDraft) {
        setExpandedDraftId(nextDraft.id);
      } else if (queuePage.nextCursor) {
        const nextPage = await loadMore();
        setExpandedDraftId(nextPage?.setterDrafts[0]?.id ?? null);
      } else {
        setExpandedDraftId(null);
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Review decision could not be saved.");
    } finally {
      setBusyDraftId(null);
    }
  }
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-text">AI Setter</h1>
        <p className="mt-1 text-sm text-text-muted">Revisa las respuestas sugeridas antes de enviarlas.</p>
      </header>

      <div className="grid max-w-xl grid-cols-2 gap-3">
        <KpiStat label="Pendientes" value={String(queuePage.pendingCount)} emphasize />
        <KpiStat
          label="Más antigua"
          value={elapsedLabel(queuePage.oldestPendingAt, now)}
        />
      </div>

      <section className="space-y-3" aria-labelledby="setter-review-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="setter-review-heading" className="text-base font-semibold text-text">Cola de conversaciones</h2>
          <span className="text-sm text-text-muted">{pendingItems.length} pendientes</span>
        </div>
        {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
        {pendingItems.length === 0 ? (
          <p className="border-y border-border py-5 text-sm text-text-muted">No hay conversaciones pendientes de revisión.</p>
        ) : (
          <div className="space-y-2">
            {pendingItems.map(({ draft, message, conversation }) => {
              const bundle = accountBundleById.get(conversation.accountId);
              const contact = bundle?.contacts.find((item) => item.id === conversation.contactId);
              const leadName = contact?.fullName ?? contact?.firstName ?? bundle?.account.canonicalName ?? "Contacto sin identificar";
              const expanded = expandedDraftId === draft.id;

              return (
                <article className="overflow-hidden rounded-md border border-border bg-surface" key={draft.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`review-${draft.id}`}
                    onClick={() => setExpandedDraftId(expanded ? null : draft.id)}
                    className="flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left hover:bg-surface-muted"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{leadName}</span>
                    <span className="max-w-48 truncate text-xs text-text-muted">{campaignById.get(conversation.campaignId)?.name ?? "Campaña"}</span>
                    <time className="text-xs text-text-muted" dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                    <Badge variant="warning">Pendiente</Badge>
                    {conversation.latestIntent && <Badge variant="neutral">{conversation.latestIntent}</Badge>}
                    {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                  </button>

                  {expanded && (
                    <div id={`review-${draft.id}`} className="space-y-4 border-t border-border p-4">
                      <section aria-labelledby={`inbound-${draft.id}`}>
                        <h3 id={`inbound-${draft.id}`} className="mb-2 text-sm font-semibold text-text">Mensaje del prospecto</h3>
                        <p className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-4 text-sm leading-relaxed text-text">{message.body}</p>
                      </section>

                      <section aria-labelledby={`suggestion-${draft.id}`}>
                        <h3 id={`suggestion-${draft.id}`} className="mb-2 text-sm font-semibold text-text">Respuesta sugerida</h3>
                        {editingDraftId === draft.id ? (
                          <textarea
                            id={`draft-${draft.id}`}
                            aria-label="Respuesta sugerida"
                            autoFocus
                            value={editedDrafts[draft.id] ?? draft.draft}
                            onChange={(change) => setEditedDrafts((current) => ({ ...current, [draft.id]: change.target.value }))}
                            rows={5}
                            maxLength={10_000}
                            className="w-full resize-y rounded-md border border-border bg-surface p-3 text-sm leading-relaxed text-text outline-none focus:border-primary"
                          />
                        ) : (
                          <p className="whitespace-pre-wrap break-words rounded-md border border-primary/30 bg-primary/5 p-4 text-sm leading-relaxed text-text">{draft.draft}</p>
                        )}
                        {(draft.confidence < 0.6 || draft.riskFlags.length > 0) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {draft.confidence < 0.6 && <Badge variant="warning">Confianza baja · {Math.round(draft.confidence * 100)}%</Badge>}
                            {draft.riskFlags.length > 0 && draft.riskFlags.map((flag) => <Badge key={flag} variant="danger">{flag}</Badge>)}
                          </div>
                        )}
                      </section>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {editingDraftId === draft.id ? (
                          <>
                            <Button size="sm" className="min-h-11" disabled={busyDraftId === draft.id || !(editedDrafts[draft.id] ?? draft.draft).trim()} onClick={() => submitReview(draft, "edit_and_send")}>
                              <Check size={15} aria-hidden="true" /> {busyDraftId === draft.id ? "Guardando..." : "Guardar y aprobar"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="min-h-11"
                              disabled={busyDraftId === draft.id}
                              onClick={() => {
                                setEditedDrafts((current) => {
                                  const next = { ...current };
                                  delete next[draft.id];
                                  return next;
                                });
                                setEditingDraftId(null);
                              }}
                            >Cancelar</Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" className="min-h-11" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "approve")}>
                              <Check size={15} aria-hidden="true" /> {busyDraftId === draft.id ? "Guardando..." : "Aprobar"}
                            </Button>
                            <Button size="sm" variant="secondary" className="min-h-11" disabled={busyDraftId === draft.id} onClick={() => setEditingDraftId(draft.id)}>
                              <FilePenLine size={15} aria-hidden="true" /> Editar
                            </Button>
                            <Button size="sm" variant="danger" className="min-h-11" disabled={busyDraftId === draft.id} onClick={() => submitReview(draft, "reject")}>
                              <X size={15} aria-hidden="true" /> Rechazar
                            </Button>
                          </>
                        )}
                      </div>

                      <details
                        className="border-t border-border pt-3"
                        onToggle={(event) => {
                          if (event.currentTarget.open) void loadHistory(conversation.id);
                        }}
                      >
                        <summary className="cursor-pointer py-2 text-sm font-medium text-text-muted">Ver historial completo ({messageCounts[conversation.id] ?? 0})</summary>
                        <div className="mt-2 space-y-3">
                          {historyLoadingIds.includes(conversation.id) && !historyByConversationId[conversation.id] && <p className="text-sm text-text-muted">Cargando historial...</p>}
                          {historyErrors[conversation.id] && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger"><span>{historyErrors[conversation.id]}</span><Button size="sm" variant="secondary" onClick={() => historyByConversationId[conversation.id]?.nextCursor ? loadOlderHistory(conversation.id) : loadHistory(conversation.id)}>Reintentar</Button></div>}
                          {(historyByConversationId[conversation.id]?.messages ?? []).map((threadMessage) => (
                            <div key={threadMessage.id} className={`max-w-[90%] rounded-md p-3 text-sm ${threadMessage.direction === "incoming" ? "bg-surface-muted text-text" : "ml-auto border border-border bg-surface text-text"}`}>
                              <p className="mb-1 text-xs font-medium text-text-muted">{threadMessage.direction === "incoming" ? "Prospecto" : "Nosotros"}</p>
                              <p className="whitespace-pre-wrap break-words">{threadMessage.body}</p>
                              <time className="mt-2 block text-right text-[11px] text-text-muted" dateTime={threadMessage.createdAt}>{new Date(threadMessage.createdAt).toLocaleString("es-ES")}</time>
                            </div>
                          ))}
                          {historyByConversationId[conversation.id]?.nextCursor && (
                            <Button size="sm" variant="secondary" disabled={historyLoadingIds.includes(conversation.id)} onClick={() => loadOlderHistory(conversation.id)}>
                              {historyLoadingIds.includes(conversation.id) ? "Cargando..." : "Cargar mensajes anteriores"}
                            </Button>
                          )}
                        </div>
                      </details>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {queuePage.nextCursor && (
          <div className="pt-2">
            <Button size="sm" variant="secondary" className="min-h-11" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Cargando..." : "Cargar más conversaciones"}
            </Button>
          </div>
        )}
      </section>

    </div>
  );
}
