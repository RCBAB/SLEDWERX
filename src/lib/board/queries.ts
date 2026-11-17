import "server-only";

import { createClient } from "@/lib/supabase/server";

import type { BoardRow, BoardStatus } from "./types";

const num = (v: number | string | null) => (v == null ? null : Number(v));

const COLUMNS =
  "plan_id, sled_id, task_id, task_name, interval_mi, interval_hours, interval_days, season_due_month, season_due_day, paused, baseline_on, baseline_mi, baseline_hours, version, last_done_source, last_done_entry_id, last_done_on, last_done_mi, last_done_hours, mileage_unknown, hours_unknown, due_on, remaining_mi, remaining_hours, remaining_days, status, status_rank, urgency";

/** Board rows for some sleds, in board order (overdue, upcoming, good, then unscheduled and paused). */
async function boardRows(sledIds: string[]) {
  if (!sledIds.length) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_board")
    .select(COLUMNS)
    .in("sled_id", sledIds)
    .order("status_rank", { ascending: true })
    .order("urgency", { ascending: true, nullsFirst: false })
    .order("task_name", { ascending: true });
  if (error) throw new Error("Could not load the maintenance board.");
  return data ?? [];
}

type ViewRow = Awaited<ReturnType<typeof boardRows>>[number];

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
