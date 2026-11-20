import { connection } from "next/server";

import { cleanupDeps } from "@/lib/cleanup/adapters";
import { createCleanupAdminClient } from "@/lib/cleanup/admin-client";
import { isAuthorizedCronRequest } from "@/lib/cleanup/auth";
import { readCleanupConfig, readCronSecret } from "@/lib/cleanup/config";
import { runCleanup, summarizeReport } from "@/lib/cleanup/run";

/**
 * Daily Recently Deleted & storage cleanup (Migration 8), called by Vercel
 * Cron with `Authorization: Bearer <CRON_SECRET>`. Report-only unless BOTH
 * CLEANUP_MODE=delete and the database's deletion switch are on.
 * Not scheduled yet: no cron entry exists in vercel.json.
 */
export const maxDuration = 60;

/** File removals start only within this time, leaving room to close the run. */
const FILE_TIME_BUDGET_MS = 40_000;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  await connection();
  const started = Date.now();

  const secret = readCronSecret(process.env);
  if (!secret) {
    console.error(JSON.stringify({ event: "sledwerx.cleanup", status: "not_configured", problem: "CRON_SECRET is not set (16+ characters)." }));
    return json({ error: "Cleanup is not configured." }, 503);
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), secret)) {
    return json({ error: "Unauthorized." }, 401);
  }

  const config = readCleanupConfig(process.env);
  if (!config.ok) {
    console.error(JSON.stringify({ event: "sledwerx.cleanup", status: "not_configured", problems: config.problems }));
    return json({ error: "Cleanup is not configured.", problems: config.problems }, 503);
  }

  const client = createCleanupAdminClient(config.config.supabaseUrl, config.config.secretKey);
  const report = await runCleanup({
    ...cleanupDeps(client),
    requestedMode: config.config.requestedMode,
    warnings: config.config.warnings,
    deadline: started + FILE_TIME_BUDGET_MS,
  });

  const summary = { ...summarizeReport(report), duration_ms: Date.now() - started };
  if (report.status === "completed") console.info(JSON.stringify(summary));
  else console.error(JSON.stringify(summary));

  return json(report, report.status === "completed" ? 200 : report.status === "busy" ? 409 : 500);
}
