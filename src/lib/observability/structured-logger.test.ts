import { describe, expect, it, vi } from "vitest";
import { buildLogLine, logEvent } from "./structured-logger";

describe("structured logger", () => {
  it("redacts any field whose key looks secret-shaped", () => {
    const line = buildLogLine("info", "provider call", {
      correlationId: "corr_1",
      provider: "instantly",
      apiKey: "sk-live-12345",
      webhookSecret: "shh",
    });
    expect(line.fields.apiKey).toBe("[REDACTED]");
    expect(line.fields.webhookSecret).toBe("[REDACTED]");
    expect(line.fields.provider).toBe("instantly");
  });

  it("masks email and phone-shaped values embedded in string fields", () => {
    const line = buildLogLine("info", "reply ingested", {
      correlationId: "corr_2",
      outcome: "ok",
      note: "from owner@farmacia.es, phone +34 600 123 456",
    });
    expect(line.fields.note).not.toContain("owner@farmacia.es");
    expect(line.fields.note).toContain("[email]");
    expect(line.fields.note).toContain("[phone]");
  });

  it("keeps non-secret, non-PII fields (correlationId, jobId, durationMs) intact", () => {
    const line = buildLogLine("info", "job completed", {
      correlationId: "corr_3",
      jobId: "job_1",
      campaignId: "camp_1",
      durationMs: 120,
      outcome: "succeeded",
    });
    expect(line.fields).toMatchObject({ correlationId: "corr_3", jobId: "job_1", campaignId: "camp_1", durationMs: 120, outcome: "succeeded" });
  });

  it("emits one JSON line to console.error for error level and console.log otherwise", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("error", "provider outage", { correlationId: "corr_4", outcome: "failed" });
    logEvent("info", "job started", { correlationId: "corr_5", outcome: "started" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
