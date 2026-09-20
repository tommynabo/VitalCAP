import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser (anon-key) Supabase client factory (Prompt 1 §1.7). Safe to call
 * from client components: the anon key only grants whatever a signed-in
 * user's workspace-scoped RLS policies allow (see
 * `supabase/migrations/0005_rls_policies.sql`) — it never bypasses RLS.
 *
 * Not wired into any page yet (Prompt 1 §1.9: the UI still reads from
 * `lib/seed/dev-seed.ts`). This factory exists so Phase 2+ can adopt it
 * without inventing a new client shape later.
 */
export function createBrowserSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to create the browser Supabase client.",
    );
  }

  return createClient(url, anonKey);
}
