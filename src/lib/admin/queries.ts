import "server-only";

import { createClient } from "@/lib/supabase/server";

import { parseDashboard, type CleanupDashboardData } from "./dashboard";

export type DashboardResult =
  | { status: "ok"; data: CleanupDashboardData }
  | { status: "forbidden" }
  | { status: "error" };

/**
 * Loads the cleanup dashboard with the signed-in user's own session (no
 * service-role key). The database function decides who may see it: it
 * refuses everyone who is not in the private administrators list.
 */
export async function getCleanupDashboard(): Promise<DashboardResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cleanup_dashboard");
  if (error) {
    // 42501: not an administrator (or not signed in). Treated as "no such page".
    return error.code === "42501" ? { status: "forbidden" } : { status: "error" };
  }
  const parsed = parseDashboard(data);
  return parsed ? { status: "ok", data: parsed } : { status: "error" };
}
