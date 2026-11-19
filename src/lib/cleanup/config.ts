/**
 * Configuration of the scheduled cleanup job (Migration 8), read from the
 * server environment. No value here is ever sent to the browser.
 *
 * Deletion needs BOTH switches: CLEANUP_MODE=delete here, and deletion
 * authorized in the database. Anything else (unset, misspelled, a preview
 * deployment) runs report-only.
 */

export type CleanupMode = "report" | "delete";

export type CleanupConfig = {
  supabaseUrl: string;
  secretKey: string;
  requestedMode: CleanupMode;
  warnings: string[];
};

export type CleanupConfigResult = { ok: true; config: CleanupConfig } | { ok: false; problems: string[] };

type Env = Record<string, string | undefined>;

/** The shared secret Vercel Cron sends; null if unset or too short to be safe. */
export function readCronSecret(env: Env): string | null {
  const secret = env.CRON_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

export function readCleanupConfig(env: Env): CleanupConfigResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!supabaseUrl) problems.push("NEXT_PUBLIC_SUPABASE_URL is not set.");
  if (!secretKey) {
    problems.push("SUPABASE_SECRET_KEY is not set.");
  } else {
    if (secretKey.startsWith("sb_publishable_") || secretKey === env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()) {
      problems.push("SUPABASE_SECRET_KEY holds the publishable key, not a secret key.");
    }
    // A NEXT_PUBLIC_ variable is built into the browser bundle.
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith("NEXT_PUBLIC_") && value?.trim() === secretKey) {
        problems.push(`The secret key is also in ${name}, which is sent to browsers. Remove it and rotate the key.`);
      }
    }
  }

  const rawMode = env.CLEANUP_MODE?.trim().toLowerCase() ?? "";
  let requestedMode: CleanupMode = "report";
  if (rawMode === "delete") {
    requestedMode = "delete";
  } else if (rawMode !== "" && rawMode !== "report") {
    warnings.push("CLEANUP_MODE is not 'report' or 'delete'; running report-only.");
  }
  // Vercel sets VERCEL_ENV. Only the production deployment may delete.
  if (requestedMode === "delete" && env.VERCEL_ENV && env.VERCEL_ENV !== "production") {
    requestedMode = "report";
    warnings.push(`Deletion is only allowed in the production deployment (this is ${env.VERCEL_ENV}); running report-only.`);
  }

  if (problems.length > 0 || !supabaseUrl || !secretKey) return { ok: false, problems };
  return { ok: true, config: { supabaseUrl, secretKey, requestedMode, warnings } };
}
