import { createNeonAuth } from "@neondatabase/auth/next/server";
import { getServerEnv } from "@/lib/config/env";

/**
 * Singleton Neon Auth server instance (Better Auth under the hood). Reads
 * `NEON_AUTH_BASE_URL`/`NEON_AUTH_COOKIE_SECRET` via `getServerEnv()`, which
 * already resolves the Neon Vercel integration's prefixed variable names.
 * Do not construct a second instance elsewhere — import `auth` from here.
 */
function buildAuth() {
  const env = getServerEnv();
  if (!env.NEON_AUTH_BASE_URL || !env.NEON_AUTH_COOKIE_SECRET) {
    // Constructed lazily (see `getAuth()`) so importing this module never
    // throws just because auth isn't configured yet (e.g. dev-seed mode).
    throw new Error(
      "NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET must both be set to use Neon Auth.",
    );
  }
  return createNeonAuth({
    baseUrl: env.NEON_AUTH_BASE_URL,
    cookies: { secret: env.NEON_AUTH_COOKIE_SECRET },
  });
}

let cachedAuth: ReturnType<typeof buildAuth> | undefined;

/** Lazily builds/returns the Neon Auth instance. Throws if not configured. */
export function getAuth() {
  if (!cachedAuth) cachedAuth = buildAuth();
  return cachedAuth;
}
