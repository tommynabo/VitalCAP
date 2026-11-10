import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { SetterPromptContext } from "@/domain/providers/types";
import { MillionVerifierEmailVerificationProvider } from "@/infrastructure/providers/email-verification/millionverifier-provider";
import { InstantlyEmailDeliveryProvider } from "@/infrastructure/providers/instantly/provider";
import { InstantlyInboxProvider } from "@/infrastructure/providers/instantly/inbox-provider";
import { InstantlyReplyProvider } from "@/infrastructure/providers/instantly/reply-provider";
import { OpenAISetterProvider } from "@/infrastructure/providers/llm/openai-setter-provider";
import { AnthropicSetterProvider } from "@/infrastructure/providers/llm/anthropic-setter-provider";
import { createSetterLLMProvider } from "@/infrastructure/providers/llm/factory";
import { ApifyClient } from "@/infrastructure/providers/maps/apify-client";
import { SerperDiscoveryProvider } from "@/infrastructure/providers/serp/serper-provider";
import { getDb, getNeonSql } from "@/infrastructure/neon/db";
import { PreviewRuntimeBlockedError } from "./preview-runtime";
import { safeFetchPage } from "./safe-fetch";

const previewEnvironmentNames = [
  "VERCEL",
  "VERCEL_ENV",
  "NODE_ENV",
  "APP_ENV",
  "DEV_SEED_MODE",
  "DEFAULT_DELIVERY_MODE",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
] as const;

async function withVercelPreview(run: () => Promise<void>): Promise<void> {
  const original = Object.fromEntries(previewEnvironmentNames.map((name) => [name, process.env[name]]));
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "preview";
  Reflect.set(process.env, "NODE_ENV", "test");
  process.env.APP_ENV = "test";
  process.env.DEV_SEED_MODE = "false";
  process.env.DEFAULT_DELIVERY_MODE = "dry_run";

  try {
    await run();
  } finally {
    for (const name of previewEnvironmentNames) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else Reflect.set(process.env, name, value);
    }
  }
}

describe("Vercel Preview outbound guards", () => {
  it("blocks Apify before invoking the injected fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new ApifyClient({ apiToken: "test-token", fetchImpl });

    await withVercelPreview(async () => {
      await expect(client.startRun("owner/actor", {})).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("blocks Serper before invoking the injected fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new SerperDiscoveryProvider({ apiKey: "test-key", fetchImpl });

    await withVercelPreview(async () => {
      await expect(provider.search({ query: "preview guard", maxResults: 1 })).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("blocks MillionVerifier before invoking the injected fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new MillionVerifierEmailVerificationProvider({ apiKey: "test-key", fetchImpl });

    await withVercelPreview(async () => {
      await expect(provider.verifyBatch(["person@example.test"])).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("blocks Instantly before invoking the injected fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: "test-key", fetchImpl });

    await withVercelPreview(async () => {
      await expect(provider.getCampaignStatus("campaign-test")).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("blocks Instantly inbox and reply clients at construction", async () => {
    const fetchImpl = vi.fn();

    await withVercelPreview(async () => {
      expect(() => new InstantlyInboxProvider("test-key", fetchImpl)).toThrow(PreviewRuntimeBlockedError);
      expect(() => new InstantlyReplyProvider("test-key", fetchImpl)).toThrow(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("blocks OpenAI before invoking the injected SDK client", async () => {
    const create = vi.fn();
    const provider = new OpenAISetterProvider({ responses: { create } } as unknown as OpenAI, "test-model");

    await withVercelPreview(async () => {
      await expect(provider.classifyAndDraft({} as SetterPromptContext)).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("blocks Anthropic before invoking the injected SDK client", async () => {
    const create = vi.fn();
    const provider = new AnthropicSetterProvider({ messages: { create } } as unknown as Anthropic, "test-model");

    await withVercelPreview(async () => {
      await expect(provider.classifyAndDraft({} as SetterPromptContext)).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("blocks live LLM client initialization in Preview", async () => {
    await withVercelPreview(async () => {
      expect(() => createSetterLLMProvider({
        LLM_PROVIDER: "openai",
        LLM_PROVIDER_API_KEY: "test-key",
        LLM_MODEL: "test-model",
      }, "test")).toThrow(PreviewRuntimeBlockedError);
    });
  });

  it("blocks Neon clients even when a database URL is configured", async () => {
    await withVercelPreview(async () => {
      expect(() => getNeonSql()).toThrow(PreviewRuntimeBlockedError);
      expect(() => getDb()).toThrow(PreviewRuntimeBlockedError);
    });
  });

  it("blocks website fetches before invoking the injected fetch", async () => {
    const fetchImpl = vi.fn();

    await withVercelPreview(async () => {
      await expect(safeFetchPage("https://example.test/", { fetchImpl })).rejects.toBeInstanceOf(PreviewRuntimeBlockedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
