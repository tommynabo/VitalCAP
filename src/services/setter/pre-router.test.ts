import { describe, expect, it } from "vitest";
import { detectDeterministicCase } from "./pre-router";

describe("detectDeterministicCase", () => {
  it("detects an unsubscribe request and flags suppress", () => {
    const result = detectDeterministicCase("Por favor, dadme de baja de esta lista.");
    expect(result.matched).toBe(true);
    expect(result.category).toBe("unsubscribe");
    expect(result.branch).toBe("UNSUBSCRIBE");
    expect(result.suppress).toBe(true);
  });

  it("detects an explicit do-not-contact request and flags suppress", () => {
    const result = detectDeterministicCase("No vuelvan a escribirme, gracias.");
    expect(result.matched).toBe(true);
    expect(result.suppress).toBe(true);
  });

  it("detects an out-of-office auto-reply without suppressing", () => {
    const result = detectDeterministicCase("I am currently out of office and will reply when I return.");
    expect(result.matched).toBe(true);
    expect(result.category).toBe("out_of_office");
    expect(result.suppress).toBe(false);
  });

  it("detects a bounce/system message", () => {
    const result = detectDeterministicCase("Delivery Status Notification (Failure): mail delivery failed");
    expect(result.matched).toBe(true);
    expect(result.category).toBe("bounce_system_message");
  });

  it("detects a hard negative reply", () => {
    const result = detectDeterministicCase("No gracias, no nos interesa en este momento.");
    expect(result.matched).toBe(true);
    expect(result.branch).toBe("NOT_INTERESTED");
    expect(result.suppress).toBe(false);
  });

  it("detects a wrong-person / forward request", () => {
    const result = detectDeterministicCase("No soy la persona indicada, mejor contacta con compras.");
    expect(result.matched).toBe(true);
    expect(result.branch).toBe("FORWARD_TO_PURCHASING");
  });

  it("returns no match for a genuine interest reply that needs the LLM", () => {
    const result = detectDeterministicCase("Nos interesa saber más sobre precios y condiciones.");
    expect(result.matched).toBe(false);
    expect(result.suppress).toBe(false);
  });

  it("prioritizes unsubscribe over hard-negative wording in the same message", () => {
    const result = detectDeterministicCase("No nos interesa, dadme de baja por favor.");
    expect(result.category).toBe("unsubscribe");
    expect(result.suppress).toBe(true);
  });
});
