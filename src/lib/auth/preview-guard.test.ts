import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
    PATCH: vi.fn(),
  };
  const auth = {
    handler: vi.fn(() => handlers),
    signIn: { email: vi.fn() },
    signOut: vi.fn(),
  };
  return {
    handlers,
    auth,
    createNeonAuth: vi.fn(() => auth),
    redirect: vi.fn(),
    isDevSeedMode: vi.fn(() => false),
  };
});

vi.mock("@neondatabase/auth/next/server", () => ({ createNeonAuth: mocks.createNeonAuth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/config/env", () => ({ isDevSeedMode: mocks.isDevSeedMode }));

const environmentNames = [
  "VERCEL",
  "VERCEL_ENV",
  "NODE_ENV",
  "APP_ENV",
  "DEV_SEED_MODE",
  "NEON_AUTH_BASE_URL",
  "Vitalcap_NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
] as const;
const testCookieSecret = "x".repeat(32);

let originalEnvironment: Record<(typeof environmentNames)[number], string | undefined>;
let authServer: typeof import("./server");
let authActions: typeof import("./actions");
let authRoutes: typeof import("@/app/api/auth/[...path]/route");
let previewRuntime: typeof import("@/lib/security/preview-runtime");
let resetAuthEnvCacheForTests: typeof import("@/lib/config/auth-env").resetAuthEnvCacheForTests;

function setEnvironment(values: Partial<Record<(typeof environmentNames)[number], string>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else Reflect.set(process.env, name, value);
  }
}

function setProductionEnvironment(): void {
  setEnvironment({
    VERCEL: "1",
    VERCEL_ENV: "production",
    NODE_ENV: "production",
    APP_ENV: "production",
    DEV_SEED_MODE: "false",
    Vitalcap_NEON_AUTH_BASE_URL: "https://auth.example.invalid",
    NEON_AUTH_COOKIE_SECRET: testCookieSecret,
  });
}

function setPreviewEnvironment(): void {
  setEnvironment({
    VERCEL: "1",
    VERCEL_ENV: "preview",
    NODE_ENV: "production",
    APP_ENV: "development",
    DEV_SEED_MODE: "false",
    Vitalcap_NEON_AUTH_BASE_URL: "https://auth.example.invalid",
    NEON_AUTH_COOKIE_SECRET: testCookieSecret,
  });
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]])) as typeof originalEnvironment;
  for (const name of environmentNames) delete process.env[name];
  vi.clearAllMocks();
  vi.resetModules();

  authServer = await import("./server");
  authActions = await import("./actions");
  authRoutes = await import("@/app/api/auth/[...path]/route");
  previewRuntime = await import("@/lib/security/preview-runtime");
  ({ resetAuthEnvCacheForTests } = await import("@/lib/config/auth-env"));

  mocks.auth.handler.mockReturnValue(mocks.handlers);
  for (const handler of Object.values(mocks.handlers)) {
    handler.mockResolvedValue(new Response("ok", { status: 200 }));
  }
  mocks.auth.signIn.email.mockResolvedValue({ error: null });
  mocks.auth.signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  authServer.resetAuthCacheForTests();
  resetAuthEnvCacheForTests();
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else Reflect.set(process.env, name, value);
  }
  vi.restoreAllMocks();
});

describe("Neon Auth Preview guard", () => {
  it("keeps auth entrypoint imports lazy without configured credentials", () => {
    expect(mocks.createNeonAuth).not.toHaveBeenCalled();
  });

  it("blocks initialization in Preview even when credentials are configured", () => {
    setPreviewEnvironment();

    expect(() => authServer.getAuth()).toThrow(previewRuntime.PreviewRuntimeBlockedError);
    expect(mocks.createNeonAuth).not.toHaveBeenCalled();
  });

  it("blocks cached auth instances when the runtime is Preview", () => {
    setProductionEnvironment();
    authServer.getAuth();
    process.env.VERCEL_ENV = "preview";

    expect(() => authServer.getAuth()).toThrow(previewRuntime.PreviewRuntimeBlockedError);
    expect(mocks.createNeonAuth).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["GET", "GET"],
    ["POST", "POST"],
    ["PUT", "PUT"],
    ["DELETE", "DELETE"],
    ["PATCH", "PATCH"],
    ["HEAD", "GET"],
  ] as const)("returns 403 for Preview %s before invoking Neon Auth", async (method, handlerName) => {
    setPreviewEnvironment();
    const handler = authRoutes[method];
    const response = await handler(
      new Request("https://vitalcap.example.invalid/api/auth/session", { method }),
      { params: Promise.resolve({ path: ["session"] }) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "forbidden" });
    expect(mocks.createNeonAuth).not.toHaveBeenCalled();
    expect(mocks.auth.handler).not.toHaveBeenCalled();
    expect(mocks.handlers[handlerName]).not.toHaveBeenCalled();
  });

  it("returns 403 for Preview OPTIONS without invoking Neon Auth", async () => {
    setPreviewEnvironment();

    const response = authRoutes.OPTIONS();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "forbidden" });
    expect(mocks.createNeonAuth).not.toHaveBeenCalled();
  });

  it("blocks Preview sign-in and sign-out actions before invoking Neon Auth", async () => {
    setPreviewEnvironment();
    const formData = new FormData();
    formData.set("email", "preview@example.invalid");
    formData.set("password", "x");

    await expect(authActions.signInWithEmailAction({ error: null }, formData))
      .rejects.toBeInstanceOf(previewRuntime.PreviewRuntimeBlockedError);
    await expect(authActions.signOutAction())
      .rejects.toBeInstanceOf(previewRuntime.PreviewRuntimeBlockedError);

    expect(mocks.createNeonAuth).not.toHaveBeenCalled();
    expect(mocks.auth.signIn.email).not.toHaveBeenCalled();
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
  });

  it("preserves Production authentication", async () => {
    setProductionEnvironment();
    const response = await authRoutes.GET(
      new Request("https://vitalcap.example.invalid/api/auth/session"),
      { params: Promise.resolve({ path: ["session"] }) },
    );
    const optionsResponse = authRoutes.OPTIONS();
    const formData = new FormData();
    formData.set("email", "production@example.invalid");
    formData.set("password", "x");

    expect(response.status).toBe(200);
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("Allow")).toBe("DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
    await authActions.signInWithEmailAction({ error: null }, formData);
    await authActions.signOutAction();
    expect(mocks.createNeonAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handlers.GET).toHaveBeenCalledTimes(1);
    expect(mocks.auth.signIn.email).toHaveBeenCalledTimes(1);
    expect(mocks.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("does not classify local development as Preview", async () => {
    setEnvironment({
      NODE_ENV: "development",
      APP_ENV: "development",
      NEON_AUTH_BASE_URL: "https://auth.example.invalid",
      NEON_AUTH_COOKIE_SECRET: testCookieSecret,
    });

    const response = await authRoutes.GET(
      new Request("https://localhost/api/auth/session"),
      { params: Promise.resolve({ path: ["session"] }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.createNeonAuth).toHaveBeenCalledTimes(1);
  });
});