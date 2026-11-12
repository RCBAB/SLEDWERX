// TEMPORARY: Supabase connection check. Remove before merging.
//
// Read-only. Creates nothing and changes no data. The response contains only
// pass/fail results and HTTP status codes: no URL, keys, or error messages.
// Disabled (404) on Vercel production.
import { connection, NextResponse } from "next/server";

import { readSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  await connection();

  if (process.env.VERCEL_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  const env = readSupabaseEnv();
  if (!env) {
    return NextResponse.json(
      { ok: false, envConfigured: false },
      { status: 500, headers: NO_STORE },
    );
  }

  // 1. Auth API health. Confirms the URL is reachable and the key is accepted.
  let authStatus = 0;
  try {
    const res = await fetch(new URL("/auth/v1/health", env.url), {
      headers: { apikey: env.publishableKey },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    authStatus = res.status;
  } catch {
    authStatus = 0; // network error or timeout
  }

  // 2. Data API through the app's server client (src/lib/supabase/server.ts).
  // Selects zero rows from a table that does not exist. A "table not found"
  // reply (PGRST205) proves the request reached the project and the key was
  // accepted; an invalid key returns 401 instead.
  let dbStatus = 0;
  let dbCode: string | null = null;
  try {
    const supabase = await createClient();
    const { error, status } = await supabase
      .from("sledwerx_connection_check_nonexistent")
      .select("*")
      .limit(0);
    dbStatus = status;
    dbCode = error?.code ?? null;
  } catch {
    dbStatus = 0;
  }

  const authOk = authStatus === 200;
  const dbOk =
    dbStatus === 200 || (dbStatus === 404 && dbCode === "PGRST205");

  return NextResponse.json(
    {
      ok: authOk && dbOk,
      envConfigured: true,
      auth: { ok: authOk, status: authStatus },
      dataApi: { ok: dbOk, status: dbStatus, code: dbCode },
      checkedAt: new Date().toISOString(),
    },
    { status: authOk && dbOk ? 200 : 502, headers: NO_STORE },
  );
}
