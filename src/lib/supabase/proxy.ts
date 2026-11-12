import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { readSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase auth session on each request and passes the updated
 * cookies to both Server Components (request) and the browser (response).
 *
 * If Supabase is not configured, the request passes through unchanged so the
 * app keeps working.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = readSupabaseEnv();
  if (!env) {
    return response;
  }

  const supabase = createServerClient(env.url, env.publishableKey, {
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
  await supabase.auth.getClaims();

  // Return `response` as is. Creating a different response without copying
  // its cookies would end the user's session.
  return response;
}
