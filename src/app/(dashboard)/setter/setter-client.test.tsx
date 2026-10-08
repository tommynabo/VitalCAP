import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SetterClient } from "./setter-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("SetterClient empty state", () => {
  it("renders safely when the initial review queue is empty", () => {
    const markup = renderToStaticMarkup(createElement(SetterClient, {
      initialQueuePage: {
        conversations: [],
        latestInboundMessages: [],
        messageCounts: {},
        setterDrafts: [],
        accountBundles: [],
        campaigns: [],
        pendingCount: 0,
        oldestPendingAt: null,
        nextCursor: null,
      },
      renderedAt: "2026-10-08T12:00:00.000Z",
    }));

    expect(markup).toContain("No hay conversaciones pendientes de revisión.");
    expect(markup).toContain("Pendientes");
  });
});