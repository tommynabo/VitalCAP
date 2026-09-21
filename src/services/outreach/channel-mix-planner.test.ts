import { describe, expect, it } from "vitest";
import { mixChannelForContactPointType, planChannelMix } from "./channel-mix-planner";

describe("mixChannelForContactPointType", () => {
  it("maps email -> email and phone -> sms", () => {
    expect(mixChannelForContactPointType("email")).toBe("email");
    expect(mixChannelForContactPointType("phone")).toBe("sms");
  });

  it("returns null for channels with no mix bucket (linkedin/other)", () => {
    expect(mixChannelForContactPointType("linkedin")).toBeNull();
    expect(mixChannelForContactPointType("other")).toBeNull();
  });
});

describe("planChannelMix", () => {
  it("allocates the full remaining target when capacity is sufficient (125/125 example)", () => {
    const plan = planChannelMix({
      desiredMix: { email: 125, sms: 125 },
      sentTodayByChannel: { email: 20, sms: 10 },
      remainingCapacityByChannel: { email: 200, sms: 200 },
    });
    const email = plan.allocations.find((a) => a.channel === "email")!;
    const sms = plan.allocations.find((a) => a.channel === "sms")!;
    expect(email.remainingTarget).toBe(105);
    expect(email.allocatable).toBe(105);
    expect(sms.remainingTarget).toBe(115);
    expect(sms.allocatable).toBe(115);
    expect(plan.totalShortfall).toBe(0);
  });

  it("reports a shortfall when capacity is less than the remaining target", () => {
    const plan = planChannelMix({
      desiredMix: { email: 125, sms: 125 },
      sentTodayByChannel: { email: 0, sms: 0 },
      remainingCapacityByChannel: { email: 40, sms: 200 },
    });
    const email = plan.allocations.find((a) => a.channel === "email")!;
    expect(email.remainingTarget).toBe(125);
    expect(email.allocatable).toBe(40);
    expect(email.shortfall).toBe(85);
    expect(plan.totalShortfall).toBe(85);
  });

  it("never allocates below zero once the target has already been met or exceeded", () => {
    const plan = planChannelMix({
      desiredMix: { email: 125, sms: 125 },
      sentTodayByChannel: { email: 130, sms: 125 },
      remainingCapacityByChannel: { email: 50, sms: 50 },
    });
    const email = plan.allocations.find((a) => a.channel === "email")!;
    const sms = plan.allocations.find((a) => a.channel === "sms")!;
    expect(email.remainingTarget).toBe(0);
    expect(email.allocatable).toBe(0);
    expect(sms.remainingTarget).toBe(0);
    expect(plan.totalShortfall).toBe(0);
  });
});
