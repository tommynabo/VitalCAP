import { describe, expect, it, vi } from "vitest";
import {
  runInstantlyInboxReconcile,
  type InstantlyInboxReconcileDependencies,
} from "./instantly-inbox-reconcile-runner";

const campaign = { providerCampaignId: "provider-campaign-1", campaignId: "campaign-1", workspaceId: "workspace-1" };
const now = new Date("2026-10-22T12:00:00.000Z");

function email(id: string) {
  return {
    id,
    campaign_id: campaign.providerCampaignId,
    lead: "lead@example.es",
    eaccount: "sender@example.es",
    subject: "Re: Details",
    body: { text: `Reply ${id}` },
    ue_type: 2,
    thread_id: "thread-1",
    timestamp_email: "2026-10-22T11:00:00.000Z",
  };
}

function dependencies(overrides: Partial<InstantlyInboxReconcileDependencies> = {}) {
  let savedCheckpoint: Awaited<ReturnType<InstantlyInboxReconcileDependencies["getCheckpoint"]>> = null;
  return {
    listCampaigns: vi.fn(async () => [campaign]),
    getCheckpoint: vi.fn(async () => savedCheckpoint),
    saveCheckpoint: vi.fn(async (_id, checkpoint) => { savedCheckpoint = checkpoint; }),
    listPendingReplies: vi.fn(async () => []),
    listReceivedEmails: vi.fn(async () => ({ items: [email("message-1")], nextStartingAfter: null })),
    listSentEmails: vi.fn(async () => ({ items: [], nextStartingAfter: null })),
    getEmail: vi.fn(async (id: string) => email(id)),
    confirmSent: vi.fn(async () => "confirmed" as const),
    ingest: vi.fn(async () => ({ outcome: "processed" as const, result: {} as never })),
    readCheckpoint: () => savedCheckpoint,
    ...overrides,
  };
}

describe("runInstantlyInboxReconcile", () => {
  it("imports a provider reply through the shared inbound processor and checkpoints the window", async () => {
    const deps = dependencies();

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(result).toMatchObject({ repliesFound: 1, newRepliesImported: 1, alreadyKnown: 0 });
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "reply_received",
      providerMessageId: "message-1",
      replyToUuid: "message-1",
      providerCampaignId: campaign.providerCampaignId,
      email: "lead@example.es",
    }), expect.any(String));
    expect(deps.saveCheckpoint).toHaveBeenCalledWith(campaign.providerCampaignId, {
      checkpointAt: now.toISOString(),
      windowStartedAt: null,
      nextStartingAfter: null,
    });
  });

  it("preserves the provider email UUID as replyToUuid for reviewed replies", async () => {
    const providerEmailId = "01956fbd-0eb1-72db-a565-82977a586084";
    const deps = dependencies({
      listReceivedEmails: vi.fn(async () => ({ items: [email(providerEmailId)], nextStartingAfter: null })),
    });

    await runInstantlyInboxReconcile(deps, { now });

    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: providerEmailId,
      replyToUuid: providerEmailId,
    }), expect.any(String));
  });

  it("resumes provider pagination and caps the total messages per run", async () => {
    const deps = dependencies({
      listReceivedEmails: vi.fn()
        .mockResolvedValueOnce({ items: [email("message-1")], nextStartingAfter: "cursor-1" })
        .mockResolvedValueOnce({ items: [email("message-2")], nextStartingAfter: null }),
    });

    const firstRun = await runInstantlyInboxReconcile(deps, { now, maxMessagesPerRun: 1 });
    expect(firstRun.repliesFound).toBe(1);
    expect(deps.readCheckpoint()).toMatchObject({ nextStartingAfter: "cursor-1" });

    const secondRun = await runInstantlyInboxReconcile(deps, { now: new Date(now.getTime() + 10_000) });
    expect(secondRun.repliesFound).toBe(1);
    expect(vi.mocked(deps.listReceivedEmails).mock.calls[1]?.[0]).toMatchObject({
      startingAfter: "cursor-1",
      minTimestampCreated: "2026-10-19T12:00:00.000Z",
    });
    expect(deps.readCheckpoint()).toMatchObject({
      checkpointAt: new Date(now.getTime() + 10_000).toISOString(),
      nextStartingAfter: null,
    });
  });

  it("rescans one hour before the last successful checkpoint and classifies provider duplicates", async () => {
    const checkpointAt = "2026-10-22T11:55:00.000Z";
    const deps = dependencies({
      getCheckpoint: vi.fn(async () => ({ checkpointAt, windowStartedAt: null, nextStartingAfter: null })),
      listReceivedEmails: vi.fn(async () => ({ items: [email("known-message")], nextStartingAfter: null })),
      ingest: vi.fn(async () => ({ outcome: "duplicate_skipped" as const })),
    });

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(deps.listReceivedEmails).toHaveBeenCalledWith(expect.objectContaining({
      minTimestampCreated: "2026-10-22T10:55:00.000Z",
    }));
    expect(result).toMatchObject({ repliesFound: 1, alreadyKnown: 1, newRepliesImported: 0 });
  });

  it("commits an empty scan as a successful checkpoint", async () => {
    const deps = dependencies({
      listReceivedEmails: vi.fn(async () => ({ items: [], nextStartingAfter: null })),
    });

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(result.processingFailures).toBe(0);
    expect(deps.saveCheckpoint).toHaveBeenCalledWith(campaign.providerCampaignId, {
      checkpointAt: now.toISOString(),
      windowStartedAt: null,
      nextStartingAfter: null,
    });
  });

  it("rejects records that do not have the documented received-email type", async () => {
    const deps = dependencies({
      listReceivedEmails: vi.fn(async () => ({ items: [{ ...email("sent-record"), ue_type: 3 }], nextStartingAfter: null })),
    });

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(result).toMatchObject({ repliesFound: 1, invalidOrUnmappable: 1, newRepliesImported: 0 });
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("confirms an accepted reply by its exact provider message ID", async () => {
    const candidate = {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.campaignId,
      conversationId: "conversation-1",
      providerCampaignId: campaign.providerCampaignId,
      providerMessageId: "outgoing-1",
      email: "lead@example.es",
      emailAccount: "sender@example.es",
      providerThreadId: "thread-1",
      replyToUuid: "incoming-1",
      subject: "Re: Details",
      finalText: "Approved reply",
      attemptedAt: "2026-10-22T11:00:00.000Z",
      setterDraftId: "draft-1",
    };
    const deps = dependencies({
      listPendingReplies: vi.fn(async () => [candidate]),
      getEmail: vi.fn(async () => ({
        id: "outgoing-1",
        campaign_id: campaign.providerCampaignId,
        lead: "lead@example.es",
        ue_type: 3,
        timestamp_email: "2026-10-22T11:01:00.000Z",
      })),
    });

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(deps.confirmSent).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: "outgoing-1",
      email: "lead@example.es",
      campaignId: campaign.campaignId,
    }));
    expect(result.outboundConfirmed).toBe(1);
  });

  it("readbacks an unknown reply only when lead, thread, account, and exact body match", async () => {
    const candidate = {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.campaignId,
      conversationId: "conversation-1",
      providerCampaignId: campaign.providerCampaignId,
      providerMessageId: null,
      email: "lead@example.es",
      emailAccount: "sender@example.es",
      providerThreadId: "thread-1",
      replyToUuid: "incoming-1",
      subject: "Re: Details",
      finalText: "Approved reply",
      attemptedAt: "2026-10-22T11:00:00.000Z",
      setterDraftId: "draft-1",
    };
    const deps = dependencies({
      listPendingReplies: vi.fn(async () => [candidate]),
      listSentEmails: vi.fn(async () => ({
        items: [
          {
            id: "outgoing-too-late",
            campaign_id: campaign.providerCampaignId,
            lead: { email: "lead@example.es" },
            eaccount: "sender@example.es",
            thread_id: "thread-1",
            body: { text: "Approved reply" },
            ue_type: 3,
            timestamp_created: "2026-10-24T11:01:00.000Z",
          },
          {
            id: "outgoing-2",
            campaign_id: campaign.providerCampaignId,
            lead: { email: "lead@example.es" },
            eaccount: "sender@example.es",
            thread_id: "thread-1",
            body: { text: "Approved reply" },
            ue_type: 3,
            timestamp_created: "2026-10-22T11:01:00.000Z",
          },
        ],
        nextStartingAfter: null,
      })),
    });

    const result = await runInstantlyInboxReconcile(deps, { now });

    expect(deps.listSentEmails).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: campaign.providerCampaignId,
      eaccount: "sender@example.es",
      search: "thread:thread-1",
    }));
    expect(deps.confirmSent).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "outgoing-2" }));
    expect(result.outboundConfirmed).toBe(1);
  });
});
