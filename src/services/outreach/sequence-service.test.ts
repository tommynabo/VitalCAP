import { describe, expect, it } from "vitest";
import type { OutreachEvent } from "@/domain/outreach/types";
import { decideNextSequenceAction, type SequenceStepDefinition } from "./sequence-service";

const STEPS: SequenceStepDefinition[] = [
  { stepIndex: 0, kind: "cold", delayAfterPreviousMs: 0 },
  { stepIndex: 1, kind: "warm_followup", delayAfterPreviousMs: 3 * 24 * 60 * 60 * 1000 },
  { stepIndex: 2, kind: "warm_followup", delayAfterPreviousMs: 5 * 24 * 60 * 60 * 1000 },
];

function event(overrides: Partial<OutreachEvent>): OutreachEvent {
  return {
    id: "ev_1",
    outreachQueueItemId: "q_1",
    state: "sent",
    providerEventId: null,
    payloadHash: null,
    occurredAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("decideNextSequenceAction", () => {
  it("sends the first cold step when there is no history yet", () => {
    const decision = decideNextSequenceAction({ steps: STEPS, events: [], now: new Date("2025-01-01T00:00:00Z") });
    expect(decision.action).toBe("send_next");
    expect(decision.nextStep?.kind).toBe("cold");
  });

  it("waits for the follow-up delay before sending the next warm step", () => {
    const events = [event({ occurredAt: "2025-01-01T00:00:00Z" })];
    const decision = decideNextSequenceAction({ steps: STEPS, events, now: new Date("2025-01-02T00:00:00Z") });
    expect(decision.action).toBe("wait");
    expect(decision.nextStep?.stepIndex).toBe(1);
  });

  it("sends the next warm follow-up once its delay has elapsed", () => {
    const events = [event({ occurredAt: "2025-01-01T00:00:00Z" })];
    const decision = decideNextSequenceAction({ steps: STEPS, events, now: new Date("2025-01-05T00:00:00Z") });
    expect(decision.action).toBe("send_next");
    expect(decision.nextStep?.kind).toBe("warm_followup");
  });

  it("pauses all further steps as soon as any reply arrives, even mid-sequence", () => {
    const events = [
      event({ id: "ev1", occurredAt: "2025-01-01T00:00:00Z", state: "sent" }),
      event({ id: "ev2", occurredAt: "2025-01-02T00:00:00Z", state: "replied" }),
    ];
    const decision = decideNextSequenceAction({ steps: STEPS, events, now: new Date("2025-01-10T00:00:00Z") });
    expect(decision.action).toBe("pause");
    expect(decision.reason).toBe("account_replied");
  });

  it("cancels the sequence permanently on a bounce or unsubscribe", () => {
    const bounced = [event({ occurredAt: "2025-01-01T00:00:00Z", state: "bounced" })];
    const decision = decideNextSequenceAction({ steps: STEPS, events: bounced, now: new Date("2025-01-10T00:00:00Z") });
    expect(decision.action).toBe("cancel");
    expect(decision.reason).toBe("terminal_state:bounced");
  });

  it("reports complete once every step has been sent", () => {
    const events = STEPS.map((_, i) => event({ id: `ev${i}`, occurredAt: `2025-01-0${i + 1}T00:00:00Z` }));
    const decision = decideNextSequenceAction({ steps: STEPS, events, now: new Date("2025-02-01T00:00:00Z") });
    expect(decision.action).toBe("complete");
  });
});
