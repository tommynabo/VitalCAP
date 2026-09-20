import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only, service-role Supabase client factory (Prompt 1 §1.7). The
 * `server-only` import makes any accidental client-component import a
 * build-time error, on top of the runtime guard below — belt and braces
 * against ever shipping the service-role key to the browser.
 *
 * Bypasses RLS entirely: only call this from trusted server code (route
 * handlers, server actions, background jobs), never per-request on behalf
 * of an untrusted end user without an additional workspace check.
 */
export function createServiceRoleSupabaseClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createServiceRoleSupabaseClient must never be called from the browser.");
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to create the service-role Supabase client.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
