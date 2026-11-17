import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  update: vi.fn(),
  buildContext: vi.fn(),
  analyze: vi.fn(),
}));

vi.mock("@/infrastructure/neon/db", () => ({
  getDb: () => ({ execute: mocks.execute, update: mocks.update }),
}));
vi.mock("./prospect-context-builder", () => ({
  ProspectContextBuilder: class {
    buildContext(...args: unknown[]) {
      return mocks.buildContext(...args);
    }
  },
}));
vi.mock("./openai-prospect-analyzer", () => ({
  OpenAIProspectAnalyzer: class {
    analyze(...args: unknown[]) {
      return mocks.analyze(...args);
    }
  },
}));

import { IntelligenceQueueProcessor } from "./queue-processor";

describe("Intelligence claim pilot isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [] });
  });

  it("uses a shared pilot-control lock and claims no jobs while active", async () => {
    const result = await new IntelligenceQueueProcessor().processBatch();
    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]![0]);

    expect(result).toEqual({ claimed: 0, completed: 0, deferred: 0, failed: 0 });
    expect(query.sql).toContain("FROM pilot_control");
    expect(query.sql).toContain("FOR SHARE");
    expect(query.sql).toContain("pilot_state.status <> 'active'");
    expect(query.sql).toContain("FOR UPDATE OF intelligence_jobs SKIP LOCKED");
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("propagates claim/control read failures before any provider or account work", async () => {
    mocks.execute.mockRejectedValue(new Error("pilot control read failed"));

    await expect(new IntelligenceQueueProcessor().processBatch()).rejects.toThrow("pilot control read failed");

    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.buildContext).not.toHaveBeenCalled();
  });
});