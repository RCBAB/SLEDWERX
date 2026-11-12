/**
 * Supabase configuration placeholder.
 *
 * SledWerx is not connected to Supabase yet. When integration begins, install
 * `@supabase/supabase-js` (and `@supabase/ssr` for server-side auth), then create
 * browser and server clients in this directory using the values below.
 *
 * Values come from environment variables only — never hard-code credentials.
 */
export type SupabaseConfig = {
  url: string;
  anonKey: string;
};

/** Returns the Supabase config, or `null` when the env vars are not set. */
export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return null;
  }

  return { url, anonKey };
}
