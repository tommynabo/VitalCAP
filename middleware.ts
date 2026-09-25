import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv, isDevSeedMode } from "@/lib/config/env";

/**
 * Protects every dashboard/admin page behind a Neon Auth session. Skipped
 * entirely in dev-seed mode (local/test default) so the seed-backed UI keeps
 * working without a real auth backend. In production this is never skipped
 * (`env.ts` already hard-fails `APP_ENV=production` + `DEV_SEED_MODE=true`).
 *
 * `/api/auth/*`, `/api/cron/*`, `/api/webhooks/*` and static assets are
 * intentionally excluded from `matcher` below — cron/webhooks authenticate
 * via `CRON_SECRET`/provider signatures, not a user session.
 */
export default async function middleware(request: NextRequest) {
  if (isDevSeedMode()) return NextResponse.next();

  const env = getServerEnv();
  if (!env.NEON_AUTH_BASE_URL || !env.NEON_AUTH_COOKIE_SECRET) {
    // Auth not configured yet — fail closed rather than silently allow access.
    return new NextResponse("Authentication is not configured.", { status: 503 });
  }

  const { getAuth } = await import("@/lib/auth/server");
  const handler = getAuth().middleware({ loginUrl: "/sign-in" });
  return handler(request);
}

export const config = {
  matcher: [
    "/",
    "/accounts/:path*",
    "/contacts/:path*",
    "/campaigns/:path*",
    "/discovery/:path*",
    "/autopilot/:path*",
    "/outreach/:path*",
    "/reviews/:path*",
    "/setter/:path*",
    "/settings/:path*",
    "/analytics/:path*",
    "/infrastructure/:path*",
    "/admin/:path*",
  ],
};
