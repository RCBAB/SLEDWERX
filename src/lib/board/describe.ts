import { formatDate } from "@/lib/sleds/format";

import type { BoardRow, BoardStatus } from "./types";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const STATUS_TONE: Record<BoardStatus, "red" | "yellow" | "green" | "neutral"> = {
  overdue: "red",
  upcoming: "yellow",
  no_record: "yellow",
  mileage_unknown: "yellow",
  good: "green",
  unscheduled: "neutral",
  paused: "neutral",
};

export const STATUS_LABEL: Record<BoardStatus, string> = {
  overdue: "Overdue",
  upcoming: "Due soon",
  no_record: "No record yet",
  mileage_unknown: "Mileage unknown",
  good: "Good",
  unscheduled: "Not scheduled",
  paused: "Paused",
};

const plural = (n: number, one: string, many: string) => `${number.format(n)} ${Math.abs(n) === 1 ? one : many}`;

export function seasonLabel(month: number, day: number): string {
  return `${MONTHS[month - 1]} ${day}`;
}

/** "Every 1,000 mi · 12 months · once a season by Nov 1", or "Not scheduled". */
export function scheduleSummary(row: Pick<BoardRow, "intervalMi" | "intervalHours" | "intervalDays" | "seasonMonth" | "seasonDay">): string {
  const parts: string[] = [];
  if (row.intervalMi != null) parts.push(`${number.format(row.intervalMi)} mi`);
  if (row.intervalHours != null) parts.push(`${number.format(row.intervalHours)} hrs`);
  if (row.intervalDays != null) {
    const { every, unit } = daysToInterval(row.intervalDays);
    parts.push(plural(every, unit.slice(0, -1), unit));
  }
  const season = row.seasonMonth != null && row.seasonDay != null ? `once a season by ${seasonLabel(row.seasonMonth, row.seasonDay)}` : null;
  if (!parts.length) return season ? season[0].toUpperCase() + season.slice(1) : "Not scheduled";
  return `Every ${parts.join(" or ")}${season ? ` · ${season}` : ""}`;
}

/** Interval in days shown as months, weeks or days (a month is 30 days). */
export function daysToInterval(days: number): { every: number; unit: "days" | "weeks" | "months" } {
  if (days % 30 === 0) return { every: days / 30, unit: "months" };
  if (days % 7 === 0) return { every: days / 7, unit: "weeks" };
  return { every: days, unit: "days" };
}

export function intervalToDays(every: number, unit: "days" | "weeks" | "months"): number {
  return every * (unit === "months" ? 30 : unit === "weeks" ? 7 : 1);
}

function daysText(days: number, dueOn: string | null): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return plural(-days, "day", "days");
  return days <= 60 || !dueOn ? plural(days, "day", "days") : `by ${formatDate(dueOn)}`;
}

/** The one-line status shown on a board row. */
export function statusLine(row: BoardRow): string {
  const { remainingMi: mi, remainingHours: hrs, remainingDays: days } = row;
  switch (row.status) {
    case "paused":
      return "Paused";
    case "unscheduled":
      return "Not scheduled";
    case "no_record":
      return "No record yet";
    case "mileage_unknown":
      return "Mileage unknown";
    case "overdue": {
      const over: string[] = [];
      if (mi != null && mi < 0) over.push(`${number.format(-mi)} mi`);
      if (hrs != null && hrs < 0) over.push(`${number.format(-hrs)} hrs`);
      if (days != null && days < 0) over.push(daysText(days, row.dueOn));
      return `Overdue by ${over.join(" and ")}`;
    }
    default: {
      const left: string[] = [];
      if (mi != null) left.push(`${number.format(mi)} mi`);
      if (hrs != null) left.push(`${number.format(hrs)} hrs`);
      if (days != null) left.push(days <= 1 ? daysText(days, row.dueOn) : daysText(days, row.dueOn));
      if (!left.length) return row.status === "upcoming" ? "Due soon" : "Good";
      const joined = left.join(" or ");
      if (days != null && days <= 1 && left.length === 1) return `Due ${joined}`;
      return `${row.status === "upcoming" ? "Due" : "Next due"} in ${joined}`.replace("in by ", "by ");
    }
  }
}

/** "Last done Dec 5, 2025 at 1,200 mi", with honest wording for unknown mileage. */
export function lastDoneLine(row: BoardRow): string {
  if (!row.lastDoneSource) return "Never done in SledWerx";
  const when = row.lastDoneOn ? formatDate(row.lastDoneOn) : "date unknown";
  // Migration 13: a "Start tracking now" starting point is never shown as done.
  const tracking = row.lastDoneSource === "baseline" && row.tracking?.replaceBaselineKind === "tracking";
  const prefix = tracking ? "Tracking since" : row.lastDoneSource === "baseline" ? "Done before SledWerx" : "Last done";
  const meters: string[] = [];
  if (row.lastDoneMi != null) meters.push(`${number.format(row.lastDoneMi)} mi`);
  else if (row.intervalMi != null || row.lastDoneSource === "service") meters.push("mileage unknown");
  if (row.lastDoneHours != null) meters.push(`${number.format(row.lastDoneHours)} hrs`);
  return `${prefix} ${when}${meters.length ? ` · ${meters.join(" · ")}` : ""}`;
}

/**
 * "Next due Jun 5, 2027 · 2,200 mi · 140 hrs". Mileage and hours are on the
 * sled's current odometer and hour meter (current reading + what's left), so
 * they match the gauges even after a meter reset. Never estimated: with no
 * known mileage, only the date (if any) is shown.
 */
export function nextDueLine(row: BoardRow, current: { odometer: number | null; engineHours: number | null }): string {
  if (row.status === "paused") return "Paused";
  if (row.status === "unscheduled") return "Not scheduled";
  const parts: string[] = [];
  if (row.dueOn) parts.push(formatDate(row.dueOn));
  if (row.remainingMi != null && current.odometer != null) parts.push(`${number.format(Math.max(0, current.odometer + row.remainingMi))} mi`);
  if (row.remainingHours != null && current.engineHours != null)
    parts.push(`${number.format(Math.max(0, current.engineHours + row.remainingHours))} hrs`);
  if (parts.length) return `Next due ${parts.join(" · ")}`;
  if (row.status === "no_record") return "Next due: starts once it's first done";
  if (row.status === "mileage_unknown") return "Next due: mileage unknown";
  return "Next due: not set";
}

/** Last done for tight spaces (Compact view): "Dec 5, 2025 · 1,200 mi", "Never". */
export function lastDoneShort(row: BoardRow): string {
  if (!row.lastDoneSource) return "Never";
  return lastDoneLine(row).replace(/^(Last done|Done before SledWerx) /, (_, prefix: string) => (prefix === "Last done" ? "" : "Before SledWerx: "));
}

/** Next due for tight spaces (Compact view): "Jun 5, 2027 · 2,200 mi". */
export function nextDueShort(row: BoardRow, current: { odometer: number | null; engineHours: number | null }): string {
  const line = nextDueLine(row, current).replace(/^Next due:? /, "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
