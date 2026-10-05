import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstantlyEmailDeliveryProvider } from "./provider";
import { resetServerEnvCacheForTests } from "@/lib/config/env";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("DEV_SEED_MODE", "false");
  vi.stubEnv("DEFAULT_DELIVERY_MODE", "dry_run");
  resetServerEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("InstantlyEmailDeliveryProvider", () => {
  it("adds campaign leads through API v2 with bearer auth while VitalCAP stays in dry-run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      status: "success",
      leads_uploaded: 1,
      duplicated_leads: 0,
      skipped_count: 0,
      created_leads: [{ id: "lead-1", index: 0 }],
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const result = await provider.addLead({
      providerCampaignId: "campaign-1",
      email: " Person@Example.com ",
      customVariables: {
        first_name: "Person",
        website: "https://example.com",
        empty: "   ",
        undefined_value: undefined as unknown as string,
        null_value: null as unknown as string,
      },
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.instantly.ai/api/v2/leads/add", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret-test-key" }),
    }));
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      campaign_id: "campaign-1",
      leads: [{ email: "person@example.com", first_name: "Person", website: "https://example.com" }],
      skip_if_in_workspace: true,
      verify_leads_on_import: false,
    });
    expect(result.result).toEqual({ providerLeadId: "lead-1", status: "added" });
  });

  it("keeps regular addLead calls network-free when DEFAULT_DELIVERY_MODE is dry-run", async () => {
    const fetchImpl = vi.fn();
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const result = await provider.addLead({
      providerCampaignId: "campaign-1",
      email: "person@example.com",
      customVariables: {},
      skipIfExisting: true,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.usage.calls).toBe(0);
  });

  it("treats a V2 duplicate as a successful idempotent skip", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      status: "success",
      leads_uploaded: 0,
      duplicated_leads: 1,
      skipped_count: 0,
      created_leads: [],
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const result = await provider.addLead({
      providerCampaignId: "campaign-1",
      email: "person@example.com",
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    });

    expect(result.result.status).toBe("skipped_existing");
  });

  it("reads account lead usage from the official V2 plan-details endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      subscriptions: { outreach: { current_lead_count: 900, total_lead_limit: 1000 } },
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    await expect(provider.getPlanUsage()).resolves.toEqual({ currentLeadCount: 900, totalLeadLimit: 1000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.instantly.ai/api/v2/workspace-billing/plan-details",
      expect.objectContaining({ headers: { Authorization: "Bearer secret-test-key" } }),
    );
  });

  it("reads monthly sent-email usage from V2 analytics without changing campaign settings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([
      { emails_sent_count: 1200 },
      { emails_sent_count: 800 },
    ]));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });
    const now = new Date("2026-10-04T12:00:00.000Z");

    await expect(provider.getMonthlyEmailUsage(now)).resolves.toEqual({ emailsSent: 2000 });
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const url = new URL(requestUrl);
    expect(url.origin + url.pathname).toBe("https://api.instantly.ai/api/v2/campaigns/analytics");
    expect(url.searchParams.get("start_date")).toBe("2026-10-01T00:00:00.000Z");
    expect(url.searchParams.get("end_date")).toBe(now.toISOString());
    expect(requestInit.headers).toEqual({ Authorization: "Bearer secret-test-key" });
  });

  it("backs off and retries a V2 rate limit", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Rate limit exceeded" }, 429))
      .mockResolvedValueOnce(jsonResponse({
        status: "success",
        leads_uploaded: 1,
        created_leads: [{ id: "lead-2", index: 0 }],
      }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl, sleepImpl });

    const result = await provider.addLead({
      providerCampaignId: "campaign-1",
      email: "person@example.com",
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
    expect(result.result.status).toBe("added");
  });

  it("submits 100 leads in one documented V2 bulk request", async () => {
    const leads = Array.from({ length: 100 }, (_, index) => ({
      id: `provider-${index}`,
      index,
    }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      status: "success",
      total_sent: 100,
      leads_uploaded: 100,
      created_leads: leads,
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const result = await provider.addLeads(Array.from({ length: 100 }, (_, index) => ({
      providerCampaignId: "campaign-1",
      email: `person-${index}@example.com`,
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    })));

    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.leads).toHaveLength(100);
    expect(payload.verify_leads_on_import).toBe(false);
    expect(payload.skip_if_in_workspace).toBe(true);
    expect(result.outcomes.every((outcome) => outcome.status === "added")).toBe(true);
    expect(result.usage.items).toBe(100);
  });

  it("reconciles created indices and marks mixed aggregate-only outcomes ambiguous", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      status: "success",
      total_sent: 3,
      leads_uploaded: 1,
      duplicated_leads: 1,
      in_blocklist: 1,
      created_leads: [{ id: "lead-2", index: 1 }],
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });
    const inputs = [0, 1, 2].map((index) => ({
      providerCampaignId: "campaign-1",
      email: `person-${index}@example.com`,
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    }));

    const result = await provider.addLeads(inputs);

    expect(result.outcomes.map(({ index, status }) => [index, status])).toEqual([
      [0, "failed"],
      [1, "added"],
      [2, "failed"],
    ]);
    expect(result.outcomes[0]?.diagnostic).toContain("individual results are ambiguous");
    expect(result.outcomes[1]?.providerLeadId).toBe("lead-2");
  });

  it("classifies a fully duplicated batch as skipped_existing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      status: "success",
      total_sent: 1,
      leads_uploaded: 0,
      duplicated_leads: 1,
      skipped_count: 0,
      created_leads: [],
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const result = await provider.addLeads([{
      providerCampaignId: "campaign-1",
      email: "person@example.com",
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    }]);

    expect(result.outcomes[0]).toMatchObject({ status: "skipped_existing", providerLeadId: null });
  });

  it("reports a leads/add 401 with sanitized endpoint diagnostics", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      statusCode: 401,
      error: "Unauthorized",
      message: "Invalid key for person@example.com",
    }), {
      status: 401,
      headers: { "Content-Type": "application/json", "x-request-id": "request-123" },
    }));
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "secret-test-key", fetchImpl });

    const errorMessage = await provider.addLead({
      providerCampaignId: "campaign-1",
      email: "person@example.com",
      customVariables: {},
      skipIfExisting: true,
      allowCampaignImportInDryRun: true,
    }).then(
      () => {
        throw new Error("Expected the provider request to reject.");
      },
      (caught: unknown) => caught instanceof Error ? caught.message : String(caught),
    );

    expect(errorMessage).toMatch(/endpoint=leads\/add http_status=401.*request_id=request-123/);
    expect(errorMessage).not.toContain("person@example.com");
  });
});