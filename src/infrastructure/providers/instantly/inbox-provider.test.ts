import { describe, expect, it, vi } from "vitest";
import { InstantlyInboxProvider } from "./inbox-provider";

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("InstantlyInboxProvider", () => {
  it("uses the documented received email filters and cursor contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      items: [{ id: "provider-email-1" }],
      next_starting_after: "cursor-1",
    }));
    const provider = new InstantlyInboxProvider("not-a-real-key", fetchImpl);

    const page = await provider.listReceivedEmails({
      campaignId: "campaign-1",
      minTimestampCreated: "2026-10-20T00:00:00.000Z",
      limit: 500,
      startingAfter: "cursor-0",
    });

    const [requestedUrl, requestInit] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(requestedUrl));
    expect(url.pathname).toBe("/api/v2/emails");
    expect(url.searchParams.get("email_type")).toBe("received");
    expect(url.searchParams.get("campaign_id")).toBe("campaign-1");
    expect(url.searchParams.get("min_timestamp_created")).toBe("2026-10-20T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("starting_after")).toBe("cursor-0");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer not-a-real-key");
    expect(page).toEqual({ items: [{ id: "provider-email-1" }], nextStartingAfter: "cursor-1" });
  });

  it("retrieves details by the provider email id for truncated list bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "provider-email-1", body: { text: "Full reply" } }));
    const provider = new InstantlyInboxProvider("not-a-real-key", fetchImpl);

    await expect(provider.getEmail("provider-email/1")).resolves.toMatchObject({ body: { text: "Full reply" } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.instantly.ai/api/v2/emails/provider-email%2F1");
  });
});
