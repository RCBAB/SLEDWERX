/**
 * Supabase connection settings, read from environment variables.
 *
 * Values are never hard-coded. Set them in `.env.local` for local development
 * and in the Vercel project settings for deployments. The publishable key is
 * designed to be exposed to the browser; access is enforced by Row Level
 * Security in the database.
 *
 * `process.env.NEXT_PUBLIC_*` must be referenced literally so Next.js can
 * inline the values into the browser bundle.
 */
export type SupabaseEnv = {
  url: string;
  publishableKey: string;
};

/** Returns the Supabase settings, or `null` if either variable is missing. */
export function readSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    return null;
  }

  return { url, publishableKey };
}

/** Returns the Supabase settings, or throws a descriptive error if missing. */
export function getSupabaseEnv(): SupabaseEnv {
  const env = readSupabaseEnv();

  if (!env) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see .env.example).",
    );
  }

  return env;
}
