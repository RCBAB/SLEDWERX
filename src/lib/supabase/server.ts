import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "./database.types";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Server Components, Server Functions, and Route Handlers.
 * It uses the signed-in user's session, so Row Level Security applies to
 * every query. Create a new client for every request; never share one.
 * There is no service-role client in this app.
 */
export async function createClient() {
  // Read cookies first: it marks the render as per-request, so a missing
  // env var fails at request time rather than during the build.
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseEnv();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot set cookies. This is safe to ignore
          // because the proxy (src/proxy.ts) refreshes the session cookies.
        }
      },
    },
  });
}
