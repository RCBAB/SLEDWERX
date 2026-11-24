import "server-only";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import type { BoardRow, BoardStatus, BoardTracking } from "./types";

const num = (v: number | string | null) => (v == null ? null : Number(v));

const COLUMNS =
  "plan_id, sled_id, task_id, task_name, interval_mi, interval_hours, interval_days, season_due_month, season_due_day, paused, baseline_on, baseline_mi, baseline_hours, version, last_done_source, last_done_entry_id, last_done_on, last_done_mi, last_done_hours, mileage_unknown, hours_unknown, due_on, remaining_mi, remaining_hours, remaining_days, status, status_rank, urgency";

/** Migration 13: both schedules of each item. */
const TRACKING_COLUMNS =
  "tracks, replace_as_needed, season_kind, replace_baseline_kind, inspect_interval_mi, inspect_interval_hours, inspect_interval_days, inspect_season_month, inspect_season_day, inspect_season_kind, inspect_each_reading, inspect_baseline_on, inspect_baseline_mi, inspect_baseline_hours, inspect_baseline_kind, replace_status, last_checked_source, last_checked_on, last_checked_mi, last_check_outcome, needs_replacement, inspect_due_on, inspect_due_mi, inspect_remaining_mi, inspect_remaining_days, inspect_due_on_reading, inspect_status, item_rank, component_mi, component_since";

type DbError = { code?: string } | null;
/** Unknown column: the database doesn't have Migration 13 yet. */
const schemaMissing = (error: DbError) => Boolean(error && ["42703", "PGRST204", "PGRST200"].includes(error.code ?? ""));

/** Board rows for some sleds, in board order (overdue, upcoming, good, then unscheduled and paused). */
async function boardRows(sledIds: string[]) {
  if (!sledIds.length) return [];
  const supabase = await createClient();
  const load = async (columns: string) => {
    const { data, error } = await supabase
      .from("maintenance_board")
      .select(columns)
      .in("sled_id", sledIds)
      .order("status_rank", { ascending: true })
      .order("urgency", { ascending: true, nullsFirst: false })
      .order("task_name", { ascending: true });
    return { data: data as unknown as ViewRow[] | null, error };
  };
  let { data, error } = await load(`${COLUMNS}, ${TRACKING_COLUMNS}`);
  if (schemaMissing(error)) ({ data, error } = await load(COLUMNS));
  if (error) throw new Error("Could not load the maintenance board.");
  return data ?? [];
}

type ViewRow = Database["public"]["Views"]["maintenance_board"]["Row"];

function toTracking(r: ViewRow): BoardTracking | null {
  if (r.tracks == null) return null;
  const kind = (v: string | null) => (v === "known" || v === "tracking" ? v : null);
  const season = (v: string | null) => (v === "season" || v === "preseason" || v === "postseason" ? v : null);
  return {
    tracks: r.tracks === "inspection" || r.tracks === "both" ? r.tracks : "replacement",
    replaceAsNeeded: Boolean(r.replace_as_needed),
    seasonKind: season(r.season_kind),
    replaceBaselineKind: kind(r.replace_baseline_kind),
    replaceStatus: (r.replace_status as BoardTracking["replaceStatus"]) ?? null,
    inspect: {
      intervalMi: num(r.inspect_interval_mi),
      intervalHours: num(r.inspect_interval_hours),
      intervalDays: r.inspect_interval_days,
      seasonMonth: r.inspect_season_month,
      seasonDay: r.inspect_season_day,
      seasonKind: season(r.inspect_season_kind),
      eachReading: Boolean(r.inspect_each_reading),
      baselineOn: r.inspect_baseline_on,
      baselineMi: num(r.inspect_baseline_mi),
      baselineHours: num(r.inspect_baseline_hours),
      baselineKind: kind(r.inspect_baseline_kind),
    },
    inspectStatus: (r.inspect_status as BoardTracking["inspectStatus"]) ?? null,
    lastCheckedSource: (r.last_checked_source as BoardTracking["lastCheckedSource"]) ?? null,
    lastCheckedOn: r.last_checked_on,
    lastCheckedMi: num(r.last_checked_mi),
    lastCheckOutcome: r.last_check_outcome === "good" || r.last_check_outcome === "needs_replacement" ? r.last_check_outcome : null,
    needsReplacement: Boolean(r.needs_replacement),
    inspectDueOn: r.inspect_due_on,
    inspectDueMi: num(r.inspect_due_mi),
    inspectRemainingMi: num(r.inspect_remaining_mi),
    inspectRemainingDays: r.inspect_remaining_days,
    inspectDueOnReading: Boolean(r.inspect_due_on_reading),
    itemRank: r.item_rank,
    componentMi: num(r.component_mi),
    componentSince: r.component_since === "replacement" || r.component_since === "tracking" ? r.component_since : null,
  };
}

function toBoardRow(r: ViewRow): BoardRow {
  return {
    planId: r.plan_id!,
    taskId: r.task_id!,
    taskName: r.task_name!,
    intervalMi: num(r.interval_mi),
    intervalHours: num(r.interval_hours),
    intervalDays: r.interval_days,
    seasonMonth: r.season_due_month,
    seasonDay: r.season_due_day,
    paused: Boolean(r.paused),
    baselineOn: r.baseline_on,
    baselineMi: num(r.baseline_mi),
    baselineHours: num(r.baseline_hours),
    version: r.version ?? 1,
    lastDoneSource: (r.last_done_source as BoardRow["lastDoneSource"]) ?? null,
    lastDoneEntryId: r.last_done_entry_id,
    lastDoneOn: r.last_done_on,
    lastDoneMi: num(r.last_done_mi),
    lastDoneHours: num(r.last_done_hours),
    mileageUnknown: Boolean(r.mileage_unknown),
    hoursUnknown: Boolean(r.hours_unknown),
    dueOn: r.due_on,
    remainingMi: num(r.remaining_mi),
    remainingHours: num(r.remaining_hours),
    remainingDays: r.remaining_days,
    status: r.status as BoardStatus,
    tracking: toTracking(r),
  };
}

/**
 * A sled's Maintenance Board, already in board order (overdue, upcoming,
 * good, then unscheduled and paused). Calculated by the maintenance_board
 * view from the service history, under the caller's Row Level Security.
 */
export async function getBoard(sledId: string): Promise<BoardRow[]> {
  return (await boardRows([sledId])).map(toBoardRow);
}

/** Several sleds' boards in one query (Garage Board), each in board order. */
export async function getBoards(sledIds: string[]): Promise<Map<string, BoardRow[]>> {
  const boards = new Map<string, BoardRow[]>(sledIds.map((id) => [id, []]));
  for (const r of await boardRows(sledIds)) boards.get(r.sled_id!)?.push(toBoardRow(r));
  return boards;
}
