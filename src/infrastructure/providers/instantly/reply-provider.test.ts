import { describe, expect, it, vi } from "vitest";
import { InstantlyReplyApiError, InstantlyReplyProvider } from "./reply-provider";

describe("InstantlyReplyProvider", () => {
  it("posts the human-approved text using the Instantly Unibox reply contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "sent-email-1" }), { status: 200 }));
    const provider = new InstantlyReplyProvider("server-only-key", fetchImpl);

    const response = await provider.reply({
      eaccount: "sender@example.es",
      replyToUuid: "incoming-email-1",
      subject: "Re: Pharmacy offer",
      text: "Human-approved response",
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.instantly.ai/api/v2/emails/reply", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        eaccount: "sender@example.es",
        reply_to_uuid: "incoming-email-1",
        subject: "Re: Pharmacy offer",
        body: { text: "Human-approved response" },
      }),
    }));
    expect(response).toEqual({ providerMessageId: "sent-email-1", responseIdentifiers: { id: "sent-email-1" } });
  });

  it("recovers eaccount from the provider email lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ eaccount: "sender@example.es" }), { status: 200 }));
    const provider = new InstantlyReplyProvider("server-only-key", fetchImpl);

    await expect(provider.resolveEmailAccount("incoming email/1")).resolves.toBe("sender@example.es");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.instantly.ai/api/v2/emails/incoming%20email%2F1",
      expect.objectContaining({ headers: { Authorization: "Bearer server-only-key" } }),
    );
  });

  it("reports only an HTTP status and never includes the provider response body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-provider-response", { status: 401 }));
    const provider = new InstantlyReplyProvider("server-only-key", fetchImpl);

    await expect(provider.reply({ eaccount: "sender", replyToUuid: "uuid", subject: "", text: "reply" }))
      .rejects.toMatchObject({ httpStatus: 401 } satisfies Partial<InstantlyReplyApiError>);
    await expect(provider.reply({ eaccount: "sender", replyToUuid: "uuid", subject: "", text: "reply" }))
      .rejects.toThrow(/HTTP 401/);
  });
});