import { formatDate } from "@/lib/sleds/format";

import { STATUS_TONE, scheduleSummary, statusLine } from "./describe";
import type { BoardRow, BoardTracking, InspectStatus, SeasonKind } from "./types";

/**
 * Inspection & replacement tracking (Migration 13): how a maintenance card
 * describes its two schedules. Replacement-only items (every existing item)
 * are described exactly as before by describe.ts; nothing here changes them.
 */

export type Tone = "red" | "yellow" | "green" | "neutral";
type Tracked = BoardRow & { tracking: BoardTracking };

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const plural = (n: number, one: string, many: string) => `${number.format(n)} ${Math.abs(n) === 1 ? one : many}`;

/** The item has an inspection schedule (Checked / Replaced instead of Done). */
export function tracksInspection(row: BoardRow): row is Tracked {
  return Boolean(row.tracking && row.tracking.tracks !== "replacement");
}

/** The item has a replacement schedule (every item except inspection only). */
export function tracksReplacement(row: BoardRow): boolean {
  return !row.tracking || row.tracking.tracks !== "inspection";
}

/** Replaced is offered on items that track replacement, and on inspection only items once flagged. */
export function canRecordReplacement(row: BoardRow): boolean {
  return tracksReplacement(row) || Boolean(row.tracking?.needsReplacement);
}

export const CHECK_TONE: Record<InspectStatus, Tone> = {
  overdue: "red",
  due: "yellow",
  initial_check: "yellow",
  upcoming: "yellow",
  mileage_unknown: "yellow",
  good: "green",
  unscheduled: "neutral",
  paused: "neutral",
};

const TONE_ORDER: Tone[] = ["neutral", "green", "yellow", "red"];
const worse = (a: Tone, b: Tone) => (TONE_ORDER.indexOf(a) >= TONE_ORDER.indexOf(b) ? a : b);

function replaceTone(row: Tracked): Tone {
  const status = row.tracking.replaceStatus;
  return status && status !== "as_needed" ? STATUS_TONE[status] : "neutral";
}

/** The card's colour: Needs Replacement is red; otherwise the more urgent schedule. */
export function itemTone(row: BoardRow): Tone {
  if (!tracksInspection(row)) return STATUS_TONE[row.status];
  if (row.tracking.needsReplacement) return "red";
  const check = row.tracking.inspectStatus ? CHECK_TONE[row.tracking.inspectStatus] : "neutral";
  return row.tracking.tracks === "both" ? worse(check, replaceTone(row)) : check;
}

/** A schedule's overall state on the sled summary and the card's data-status. */
export type ItemState =
  | "needs_replacement"
  | "overdue"
  | "check_due"
  | "upcoming"
  | "no_record"
  | "mileage_unknown"
  | "good"
  | "not_tracked";
const STATE_ORDER: ItemState[] = [
  "not_tracked",
  "good",
  "mileage_unknown",
  "no_record",
  "upcoming",
  "check_due",
  "overdue",
  "needs_replacement",
];

const CHECK_STATE: Record<InspectStatus, ItemState> = {
  overdue: "overdue",
  due: "check_due",
  initial_check: "check_due",
  upcoming: "upcoming",
  mileage_unknown: "mileage_unknown",
  good: "good",
  unscheduled: "not_tracked",
  paused: "not_tracked",
};

const REPLACE_STATE: Record<NonNullable<BoardTracking["replaceStatus"]>, ItemState> = {
  overdue: "overdue",
  upcoming: "upcoming",
  no_record: "no_record",
  mileage_unknown: "mileage_unknown",
  good: "good",
  unscheduled: "not_tracked",
  paused: "not_tracked",
  as_needed: "not_tracked",
};

/** The item's most urgent state across both schedules (replacement-only items: their status). */
export function itemState(row: BoardRow): ItemState {
  if (!tracksInspection(row)) return REPLACE_STATE[row.status];
  if (row.tracking.needsReplacement) return "needs_replacement";
  const check = row.tracking.inspectStatus ? CHECK_STATE[row.tracking.inspectStatus] : "not_tracked";
  if (row.tracking.tracks !== "both" || !row.tracking.replaceStatus) return check;
  const replace = REPLACE_STATE[row.tracking.replaceStatus];
  return STATE_ORDER.indexOf(check) >= STATE_ORDER.indexOf(replace) ? check : replace;
}

function daysText(days: number, dueOn: string | null): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return plural(-days, "day", "days");
  return days <= 60 || !dueOn ? plural(days, "day", "days") : `by ${formatDate(dueOn)}`;
}

/** The check schedule's status: "Check due in 12 days", "Initial check needed", "Check overdue by 40 mi". */
export function checkLine(row: Tracked): string {
  const t = row.tracking;
  const mi = t.inspectRemainingMi;
  const hrs = t.inspectRemainingHours;
  const days = t.inspectRemainingDays;
  switch (t.inspectStatus) {
    case "paused":
      return "Paused";
    case "unscheduled":
      return "Check not scheduled";
    case "initial_check":
      return "Initial check needed";
    case "mileage_unknown":
      return "Check: mileage unknown";
    case "due":
      return "Check due: mileage updated";
    case "overdue": {
      const over: string[] = [];
      if (mi != null && mi < 0) over.push(`${number.format(-mi)} mi`);
      if (hrs != null && hrs < 0) over.push(`${number.format(-hrs)} hrs`);
      if (days != null && days < 0) over.push(daysText(days, t.inspectDueOn));
      return over.length ? `Check overdue by ${over.join(" and ")}` : "Check overdue";
    }
    default: {
      const left: string[] = [];
      if (mi != null) left.push(`${number.format(mi)} mi`);
      if (hrs != null) left.push(`${number.format(hrs)} hrs`);
      if (days != null) left.push(daysText(days, t.inspectDueOn));
      const soon = t.inspectStatus === "upcoming";
      if (!left.length) return t.inspect.eachReading ? "Check at the next mileage update" : soon ? "Check due soon" : "Check good";
      if (days != null && days <= 1 && left.length === 1) return `Check due ${left[0]}`;
      const line = `${soon ? "Check due" : "Next check"} in ${left.join(" or ")}`.replace("in by ", "by ");
      return t.inspect.eachReading ? `${line}, or at the next mileage update` : line;
    }
  }
}

function meters(mi: number | null, hours: number | null): string {
  const parts: string[] = [];
  if (mi != null) parts.push(`${number.format(mi)} mi`);
  if (hours != null) parts.push(`${number.format(hours)} hrs`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export const OUTCOME_LABEL = { good: "Good", needs_replacement: "Needs Replacement" } as const;

/**
 * What the check schedule counts from, always worded as "Last checked":
 * "Last checked Nov 3, 2026 · 1,200 mi · Good". When a replacement satisfied
 * the check (Replaced resets both schedules; on an inspection only item an
 * earlier completion counts as a check, Decision D), it says so.
 */
export function checkedLine(row: Tracked): string {
  const t = row.tracking;
  const when = t.lastCheckedOn ? formatDate(t.lastCheckedOn) : "date unknown";
  const at = meters(t.lastCheckedMi, t.lastCheckedHours);
  switch (t.lastCheckedSource) {
    case "check":
      return `Last checked ${when}${at}${t.lastCheckOutcome ? ` · ${OUTCOME_LABEL[t.lastCheckOutcome]}` : ""}`;
    case "replacement":
    case "service":
      return `Last checked ${when}${at} · satisfied by a replacement`;
    case "baseline": {
      // The replacement's starting point (Both) or the check's own.
      const i = t.inspect;
      const own = i.baselineOn === t.lastCheckedOn && i.baselineMi === t.lastCheckedMi && i.baselineHours === t.lastCheckedHours;
      const fromReplacement = !own;
      return `Last checked ${when}${at} · ${fromReplacement ? "satisfied by a replacement before SledWerx" : "before SledWerx"}`;
    }
    case "tracking":
      return `Tracking since ${when}${at}`;
    default:
      return "Never checked";
  }
}

/** The replacement schedule's status: "Replace in 800 mi", "Replace as needed", "Replacement overdue by 50 mi". */
export function replaceLine(row: Tracked): string {
  const status = row.tracking.replaceStatus;
  if (status === "as_needed") return "Replace as needed";
  if (status === "paused") return "Paused";
  if (status === "unscheduled") return "Replacement not scheduled";
  if (status === "no_record") return "No replacement recorded";
  if (status === "mileage_unknown") return "Replacement: mileage unknown";
  if (status === "overdue") return `Replacement o${statusLine(row).slice(1)}`;
  const line = statusLine(row);
  if (line === "Good") return "Replacement good";
  if (line === "Due soon") return "Replacement due soon";
  return line.replace(/^(Next due|Due) /, "Replace ");
}

/** "Replaced Oct 1, 2026 · 1,200 mi · 1,240 mi on it", "Tracking since Nov 1, 2026". */
export function replacedLine(row: Tracked): string {
  const t = row.tracking;
  const when = row.lastDoneOn ? formatDate(row.lastDoneOn) : "date unknown";
  const on = t.componentMi != null && t.componentMi >= 0 ? ` · ${number.format(t.componentMi)} mi on it` : "";
  if (row.lastDoneSource === "service") return `Replaced ${when}${meters(row.lastDoneMi, row.lastDoneHours)}${on}`;
  if (row.lastDoneSource === "baseline") {
    if (t.replaceBaselineKind === "tracking") return `Tracking since ${when}${on.replace("on it", "since")}`;
    return `Replaced before SledWerx ${when}${meters(row.lastDoneMi, row.lastDoneHours)}${on}`;
  }
  return "Never replaced in SledWerx";
}

const SEASON_TEXT: Record<SeasonKind, string> = { preseason: "preseason", postseason: "postseason", season: "once a season" };
const lowerFirst = (text: string) => text[0].toLowerCase() + text.slice(1);

/** A schedule summary in lower case, with its season label ("preseason by Dec 1"). */
function summaryText(summary: string, kind: SeasonKind | null): string | null {
  if (summary === "Not scheduled") return null;
  return lowerFirst(summary).replace("once a season", SEASON_TEXT[kind ?? "season"]);
}

/** "Check: every 30 days · preseason by Dec 1 · every mileage update". */
export function checkScheduleSummary(row: Tracked): string {
  const i = row.tracking.inspect;
  const base = summaryText(scheduleSummary(i), i.seasonKind);
  const parts = [base, i.eachReading ? "every mileage update" : null].filter(Boolean);
  return `Check: ${parts.length ? parts.join(" · ") : "not scheduled"}`;
}

/** "Replace: every 2,000 mi", "Replace: as needed". */
export function replaceScheduleSummary(row: Tracked): string {
  const base = summaryText(scheduleSummary(row), row.tracking.seasonKind);
  const asNeeded = row.tracking.replaceAsNeeded;
  if (!base) return `Replace: ${asNeeded ? "as needed" : "not scheduled"}`;
  return `Replace: ${base}${asNeeded ? " · or as needed" : ""}`;
}

/** Short chips for tight spaces (Compact view, wall display): only what needs attention. */
export function trackingChips(row: Tracked): { label: string; tone: Tone }[] {
  const t = row.tracking;
  const chips: { label: string; tone: Tone }[] = [];
  if (t.needsReplacement) chips.push({ label: "Needs Replacement", tone: "red" });
  const check: Partial<Record<InspectStatus, string>> = {
    overdue: "Check overdue",
    due: "Check due",
    initial_check: "Initial check",
    upcoming: "Check soon",
    mileage_unknown: "Check: mileage unknown",
  };
  if (t.inspectStatus && check[t.inspectStatus]) chips.push({ label: check[t.inspectStatus]!, tone: CHECK_TONE[t.inspectStatus] });
  if (t.tracks === "both" && (t.replaceStatus === "overdue" || t.replaceStatus === "upcoming")) {
    chips.push({ label: t.replaceStatus === "overdue" ? "Replace overdue" : "Replace soon", tone: STATUS_TONE[t.replaceStatus] });
  }
  return chips;
}

/** An item in Quick Check: due (included) or due soon (shown, set to Skip). */
export type CheckItem = { taskId: string; name: string; due: boolean; status: InspectStatus };

const DUE: InspectStatus[] = ["overdue", "due", "initial_check"];

/**
 * Quick Check (Decision F): overdue, due and initial-check inspections,
 * included; then those due soon, set to Skip. In board order.
 */
export function quickCheckItems(rows: BoardRow[]): CheckItem[] {
  const items = rows.filter(tracksInspection).flatMap((r) => {
    const status = r.tracking.inspectStatus;
    if (!status || (!DUE.includes(status) && status !== "upcoming")) return [];
    return [{ taskId: r.taskId, name: r.taskName, due: DUE.includes(status), status }];
  });
  return [...items.filter((i) => i.due), ...items.filter((i) => !i.due)];
}

/** How many inspections are due now (the Quick Check button's count). */
export function checksDue(rows: BoardRow[]): number {
  return quickCheckItems(rows).filter((i) => i.due).length;
}
