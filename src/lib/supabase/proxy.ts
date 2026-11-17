import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "./database.types";
import { readSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase auth session on each request and passes the updated
 * cookies to both Server Components (request) and the browser (response).
 *
 * Returns whether the request has a valid session, for the proxy's
 * optimistic redirects. Pages still check the session themselves.
 *
 * If Supabase is not configured, the request passes through unchanged.
 */
export async function updateSession(
  request: NextRequest,
): Promise<{ response: NextResponse; signedIn: boolean }> {
  let response = NextResponse.next({ request });

  const env = readSupabaseEnv();
  if (!env) {
    return { response, signedIn: false };
  }

  const supabase = createServerClient<Database>(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        // Cache-control headers that stop CDNs from caching auth responses.
        Object.entries(headers).forEach(([key, value]) =>
          response.headers.set(key, value),
        );
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it validates
  // the JWT and refreshes an expired session, which writes the new cookies.
  const { data } = await supabase.auth.getClaims();

  // Return `response` as is. Creating a different response without copying
  // its cookies would end the user's session.
  return { response, signedIn: Boolean(data?.claims?.sub) };
}
