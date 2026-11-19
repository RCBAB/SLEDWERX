import "server-only";

import { getBoards } from "@/lib/board/queries";
import { listIssues } from "@/lib/issues/queries";
import { getActiveSuspensions } from "@/lib/suspension/queries";
import type { ActiveSuspension } from "@/lib/suspension/types";
import type { Issue } from "@/lib/issues/types";
import type { BoardRow } from "@/lib/board/types";
import { listPackages, sledRoles, taskOptionsForSleds, type MaintenancePackage, type TaskOption } from "@/lib/service/queries";
import type { SledRole } from "@/lib/sleds/constants";
import { sledCapabilities } from "@/lib/sleds/permissions";
import { listGarageSleds, type SledListItem } from "@/lib/sleds/queries";
import type { RangeReading } from "@/lib/service/meter-range";
import { createClient } from "@/lib/supabase/server";

import { keyboardFromGarageMode, layoutFromGarageMode, type GarageLayout } from "./layout";

export type GarageBoardSled = {
  sled: SledListItem;
  role: SledRole;
  canComplete: boolean;
  /** Owners, editors and mechanics add mileage / hours readings. */
  canAddReading: boolean;
  /** Owners and editors change schedules (on the sled's own page). */
  canManage: boolean;
  rows: BoardRow[];
  /** Open issues, most urgent first. */
  issues: Issue[];
  /** The active suspension setup, if any (Phase 6.2). */
  suspension: ActiveSuspension | null;
  taskOptions: TaskOption[];
  readings: RangeReading[];
};

export type GarageBoardData = {
  userId: string;
  layout: GarageLayout;
  /** Wall Display on-screen keyboard on (default) or off. */
  keyboard: boolean;
  owned: GarageBoardSled[];
  shared: GarageBoardSled[];
  packages: MaintenancePackage[];
  /** When this was loaded (shown as "Updated" on the wall display). */
  loadedAt: string;
};

/**
 * Everything the Garage Board shows, in a fixed number of queries however
 * many sleds there are. Every query runs as the signed-in user, so Row Level
 * Security decides what is visible, exactly as on each sled's own page.
 * Sleds stay in the order they were added (yours first, then shared).
 */
export async function getGarageBoard(userId: string): Promise<GarageBoardData> {
  const supabase = await createClient();
  const [sleds, roles, prefs] = await Promise.all([
    listGarageSleds(),
    sledRoles(userId),
    supabase.from("user_preferences").select("garage_mode").eq("id", userId).maybeSingle(),
  ]);
  const layout = layoutFromGarageMode(prefs.data?.garage_mode);
  const keyboard = keyboardFromGarageMode(prefs.data?.garage_mode);
  const withRoles = sleds.map((sled) => {
    const role: SledRole = sled.ownerId === userId ? "owner" : (roles.get(sled.id) ?? "viewer");
    return { sled, role, can: sledCapabilities(role) };
  });
  const completable = withRoles.filter((s) => s.can.canLogService).map((s) => s.sled);

  const [boards, options, packages, issues, suspensions] = await Promise.all([
    getBoards(sleds.map((s) => s.id)),
    taskOptionsForSleds(completable),
    completable.length ? listPackages(userId) : Promise.resolve([]),
    listIssues(
      sleds.map((s) => s.id),
      "open",
    ),
    getActiveSuspensions(sleds.map((s) => s.id)),
  ]);

  const entries = withRoles.map(({ sled: { readings, ...sled }, role, can }) => ({
    sled,
    role,
    canComplete: can.canLogService,
    canAddReading: can.canAddReading,
    canManage: can.canManageSledTasks,
    rows: boards.get(sled.id) ?? [],
    issues: issues.get(sled.id) ?? [],
    suspension: suspensions.get(sled.id) ?? null,
    taskOptions: options.get(sled.id) ?? [],
    readings,
  }));

  return {
    userId,
    layout,
    keyboard,
    owned: entries.filter((e) => e.role === "owner"),
    shared: entries.filter((e) => e.role !== "owner"),
    packages,
    loadedAt: new Date().toISOString(),
  };
}
