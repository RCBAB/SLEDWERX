import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/** Pages that require a signed-in user. */
const PROTECTED_PREFIXES = ["/garage"];
/** Pages a signed-in user is sent past, straight to their garage. */
const SIGNED_OUT_ONLY = ["/", "/login", "/signup"];

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Redirect while keeping any refreshed session cookies and cache headers. */
function redirectKeepingSession(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  return redirect;
}

/**
 * Refreshes the session, then makes optimistic redirects:
 * signed-out visitors to /login, signed-in users from public pages to
 * /garage. Pages verify the session again on the server.
 */
export async function proxy(request: NextRequest) {
  const { response, signedIn } = await updateSession(request);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && isProtected(pathname)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", `${pathname}${search}`);
    return redirectKeepingSession(url, response);
  }

  if (signedIn && SIGNED_OUT_ONLY.includes(pathname)) {
    return redirectKeepingSession(new URL("/garage", request.url), response);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on all paths except static assets:
     * - _next/static, _next/image
     * - favicon.ico, manifest.webmanifest, /icons/*
     * - image files
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
