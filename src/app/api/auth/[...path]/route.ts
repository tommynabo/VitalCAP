import { getAuth } from "@/lib/auth/server";
import { assertNotVercelPreview, PreviewRuntimeBlockedError } from "@/lib/security/preview-runtime";

type RouteContext = { params: Promise<{ path: string[] }> };

function previewForbiddenResponse(): Response | undefined {
  try {
    assertNotVercelPreview("Neon Auth");
  } catch (error) {
    if (error instanceof PreviewRuntimeBlockedError) {
      return Response.json({ status: "forbidden" }, { status: 403 });
    }
    throw error;
  }
}

/**
 * Lazily resolves the Neon Auth handler per-request instead of at module
 * load time, so this route file can be imported during `next build`
 * (Next.js route collection) even before `NEON_AUTH_BASE_URL`/
 * `NEON_AUTH_COOKIE_SECRET` are configured (e.g. dev-seed mode).
 */
function lazyMethod(method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH") {
  return (request: Request, context: RouteContext) => {
    const blockedResponse = previewForbiddenResponse();
    if (blockedResponse) return blockedResponse;
    return getAuth().handler()[method](request, context);
  };
}

export const GET = lazyMethod("GET");
export const POST = lazyMethod("POST");
export const PUT = lazyMethod("PUT");
export const DELETE = lazyMethod("DELETE");
export const PATCH = lazyMethod("PATCH");
export const HEAD = lazyMethod("GET");

export function OPTIONS(): Response {
  const blockedResponse = previewForbiddenResponse();
  if (blockedResponse) return blockedResponse;
  return new Response(null, {
    status: 204,
    headers: { Allow: "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT" },
  });
}
