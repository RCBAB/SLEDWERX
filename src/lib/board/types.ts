export type BoardStatus = "overdue" | "upcoming" | "no_record" | "mileage_unknown" | "good" | "unscheduled" | "paused";

/** One row of the maintenance_board view (Migration 5). Mileage is lifetime miles. */
export type BoardRow = {
  planId: string;
  taskId: string;
  taskName: string;
  intervalMi: number | null;
  intervalHours: number | null;
  intervalDays: number | null;
  seasonMonth: number | null;
  seasonDay: number | null;
  paused: boolean;
  baselineOn: string | null;
  baselineMi: number | null;
  baselineHours: number | null;
  version: number;
  lastDoneSource: "service" | "baseline" | null;
  lastDoneEntryId: string | null;
  lastDoneOn: string | null;
  lastDoneMi: number | null;
  lastDoneHours: number | null;
  mileageUnknown: boolean;
  hoursUnknown: boolean;
  dueOn: string | null;
  remainingMi: number | null;
  remainingHours: number | null;
  remainingDays: number | null;
  status: BoardStatus;
};
