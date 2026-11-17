import type { EmailOtpType } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["signup", "email", "recovery", "invite", "email_change", "magiclink"];

/**
 * Handles links from Supabase Auth emails (sign-up confirmation, password
 * reset). Supports the recommended token_hash links, which work on any
 * device, and PKCE `code` links from the default templates.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");
  const next = safeNextPath(params.get("next"));

  const supabase = await createClient();
  let ok = false;

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }

  if (!ok) {
    return redirectTo("/login?error=link");
  }

  return redirectTo(type === "recovery" ? "/reset-password" : next);
}

/**
 * Same-origin redirect with a relative Location, so the browser stays on the
 * host it used. (request.url can name the server's own hostname instead,
 * which would drop the session cookie this route just set.)
 */
function redirectTo(path: string) {
  return new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}
