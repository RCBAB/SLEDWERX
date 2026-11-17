import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
};

/**
 * The signed-in user for this request, verified by Supabase (getClaims
 * validates the JWT). Cached per request. Returns null when signed out.
 *
 * Reads cookies, so callers must render inside a <Suspense> boundary
 * (Cache Components).
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) {
    return null;
  }
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  };
});

/** The signed-in user, or a redirect to the login page. */
export async function requireUser(next = "/garage"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return user;
}
