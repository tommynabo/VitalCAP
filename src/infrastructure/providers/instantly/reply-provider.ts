const INSTANTLY_API_BASE_URL = "https://api.instantly.ai/api/v2";

export class InstantlyReplyApiError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Instantly reply API returned HTTP ${httpStatus}.`);
    this.name = "InstantlyReplyApiError";
  }
}

export interface InstantlyReplyRequest {
  eaccount: string;
  replyToUuid: string;
  subject: string;
  text: string;
}

export interface InstantlyReplyResponse {
  providerMessageId: string | null;
  responseIdentifiers: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export class InstantlyReplyProvider {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error("Instantly API key is not configured.");
  }

  async resolveEmailAccount(replyToUuid: string): Promise<string | null> {
    const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/emails/${encodeURIComponent(replyToUuid)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new InstantlyReplyApiError(response.status);

    const payload = record(await response.json());
    const data = record(payload?.data) ?? payload;
    return firstString(data?.eaccount, data?.email_account);
  }

  async reply(input: InstantlyReplyRequest): Promise<InstantlyReplyResponse> {
    const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/emails/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eaccount: input.eaccount,
        reply_to_uuid: input.replyToUuid,
        subject: input.subject,
        body: { text: input.text },
      }),
    });
    if (!response.ok) throw new InstantlyReplyApiError(response.status);

    let payload: Record<string, unknown> | null = null;
    try {
      payload = record(await response.json());
    } catch {
      payload = null;
    }
    const data = record(payload?.data) ?? payload;
    const identifiers: Record<string, string> = {};
    for (const key of ["id", "email_id", "message_id", "uuid"]) {
      const value = firstString(data?.[key]);
      if (value) identifiers[key] = value;
    }

    return {
      providerMessageId: firstString(identifiers.id, identifiers.email_id, identifiers.message_id, identifiers.uuid),
      responseIdentifiers: identifiers,
    };
  }
}