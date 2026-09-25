import { getAuth } from "@/lib/auth/server";

type RouteContext = { params: Promise<{ path: string[] }> };

/**
 * Lazily resolves the Neon Auth handler per-request instead of at module
 * load time, so this route file can be imported during `next build`
 * (Next.js route collection) even before `NEON_AUTH_BASE_URL`/
 * `NEON_AUTH_COOKIE_SECRET` are configured (e.g. dev-seed mode).
 */
function lazyMethod(method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH") {
  return (request: Request, context: RouteContext) => getAuth().handler()[method](request, context);
}

export const GET = lazyMethod("GET");
export const POST = lazyMethod("POST");
export const PUT = lazyMethod("PUT");
export const DELETE = lazyMethod("DELETE");
export const PATCH = lazyMethod("PATCH");
