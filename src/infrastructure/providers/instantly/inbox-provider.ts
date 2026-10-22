import { InstantlyReplyApiError } from "./reply-provider";

const INSTANTLY_API_BASE_URL = "https://api.instantly.ai/api/v2";

export const INSTANTLY_INBOX_LIST_ENDPOINT = "GET /api/v2/emails";
export const INSTANTLY_EMAIL_DETAIL_ENDPOINT = "GET /api/v2/emails/{id}";
export const INSTANTLY_CURRENT_WORKSPACE_ENDPOINT = "GET /api/v2/workspaces/current";

export interface InstantlyInboxPage {
  items: Record<string, unknown>[];
  nextStartingAfter: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class InstantlyInboxProvider {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error("Instantly API key is not configured.");
  }

  async listReceivedEmails(input: {
    campaignId?: string;
    minTimestampCreated: string;
    limit: number;
    startingAfter: string | null;
  }): Promise<InstantlyInboxPage> {
    return this.listEmails("received", input);
  }

  async listSentEmails(input: {
    campaignId: string;
    minTimestampCreated: string;
    limit: number;
    startingAfter: string | null;
    eaccount?: string | null;
    search?: string | null;
  }): Promise<InstantlyInboxPage> {
    return this.listEmails("sent", input);
  }

  private async listEmails(emailType: "received" | "sent", input: {
    campaignId?: string;
    minTimestampCreated: string;
    limit: number;
    startingAfter: string | null;
    eaccount?: string | null;
    search?: string | null;
  }): Promise<InstantlyInboxPage> {
    const url = new URL(`${INSTANTLY_API_BASE_URL}/emails`);
    url.searchParams.set("email_type", emailType);
    if (input.campaignId) url.searchParams.set("campaign_id", input.campaignId);
    url.searchParams.set("min_timestamp_created", input.minTimestampCreated);
    url.searchParams.set("limit", String(Math.min(100, Math.max(1, input.limit))));
    url.searchParams.set("sort_order", "asc");
    if (input.startingAfter) url.searchParams.set("starting_after", input.startingAfter);
    if (input.eaccount) url.searchParams.set("eaccount", input.eaccount);
    if (input.search) url.searchParams.set("search", input.search);

    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new InstantlyReplyApiError(response.status);

    const payload = record(await response.json());
    const data = record(payload?.data) ?? payload;
    const items = Array.isArray(data?.items) ? data.items.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
    const nextStartingAfter = typeof data?.next_starting_after === "string" && data.next_starting_after.trim()
      ? data.next_starting_after.trim()
      : null;
    return { items, nextStartingAfter };
  }

  async getEmail(emailId: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/emails/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new InstantlyReplyApiError(response.status);

    const payload = record(await response.json());
    const data = record(payload?.data) ?? payload;
    if (!data) throw new Error("Instantly email detail response was invalid.");
    return data;
  }

  async getCurrentWorkspaceId(): Promise<string> {
    const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/workspaces/current`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new InstantlyReplyApiError(response.status);

    const payload = record(await response.json());
    const data = record(payload?.data) ?? payload;
    const workspaceId = typeof data?.id === "string" && data.id.trim() ? data.id.trim() : null;
    if (!workspaceId) throw new Error("Instantly current workspace response did not include an id.");
    return workspaceId;
  }
}
