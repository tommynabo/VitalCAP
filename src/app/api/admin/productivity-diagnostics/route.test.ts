import { beforeEach, describe, expect, it, vi } from "vitest";

const requireWorkspaceOwner = vi.fn();
const getProductivityDiagnostics = vi.fn();

vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireWorkspaceOwner,
}));
vi.mock("@/infrastructure/neon/repositories/productivity-diagnostics", () => ({
  getProductivityDiagnostics,
  ProductivityDiagnosticsStageError: class ProductivityDiagnosticsStageError extends Error {
    stage: string;
    sqlState: string | null;
    errorClass: string;

    constructor(stage: string, originalError: unknown) {
      super("Productivity diagnostics query failed");
      this.stage = stage;
      const error = originalError as { code?: unknown };
      this.sqlState = typeof error.code === "string" ? error.code : null;
      this.errorClass = originalError instanceof Error ? originalError.constructor.name : "Error";
    }
  },
}));

const route = await import("./route");

describe("/api/admin/productivity-diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1", role: "owner" });
    getProductivityDiagnostics.mockResolvedValue({ timezone: "Europe/Madrid", autoSendEnabled: false });
  });

  it("requires owner authorization before querying diagnostics", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/workspace");
    requireWorkspaceOwner.mockRejectedValue(new UnauthorizedError());

    const response = await route.GET();

    expect(response.status).toBe(403);
    expect(getProductivityDiagnostics).not.toHaveBeenCalled();
  });

  it("scopes the no-store response to the authorized workspace", async () => {
    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getProductivityDiagnostics).toHaveBeenCalledWith("workspace-1");
    await expect(response.json()).resolves.toEqual({ timezone: "Europe/Madrid", autoSendEnabled: false });
  });

  it("logs safe stage metadata while returning only the generic failure", async () => {
    const { ProductivityDiagnosticsStageError } = await import("@/infrastructure/neon/repositories/productivity-diagnostics");
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    class DatabaseError extends Error {}
    getProductivityDiagnostics.mockRejectedValue(
      new ProductivityDiagnosticsStageError(
        "unprocessed_raw",
        Object.assign(new DatabaseError("SELECT private field for contact@example.com"), { code: "42703" }),
      ),
    );

    const response = await route.GET();
    const body = await response.json();
    const logLine = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      message: string;
      fields: Record<string, unknown>;
    };

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Productivity diagnostics unavailable." });
    expect(logLine.message).toBe("productivity_diagnostics_failed");
    expect(logLine.fields).toMatchObject({
      stage: "unprocessed_raw",
      sqlState: "42703",
      errorClass: "DatabaseError",
    });
    expect(logLine.fields.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify({ body, logLine })).not.toMatch(/SELECT|contact@example\.com|workspace-1|private/i);
    logSpy.mockRestore();
  });

  it("exposes only GET and contains no provider-write route", () => {
    expect(Object.keys(route)).toEqual(["dynamic", "GET"]);
  });
});