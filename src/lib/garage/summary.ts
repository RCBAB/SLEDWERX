import type { BoardRow } from "@/lib/board/types";

export type SledTone = "red" | "yellow" | "green" | "neutral";

export type SledSummary = {
  tone: SledTone;
  /** Short label for the overall status. */
  label: string;
  /** e.g. "2 overdue · 1 due soon", or "All 4 up to date". */
  detail: string;
  counts: { overdue: number; dueSoon: number; noRecord: number; unknown: number; good: number; notTracked: number };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A sled's overall maintenance status, from its board rows: red if anything
 * is overdue, yellow if anything is due soon, has no record yet or has unknown
 * mileage, green if every scheduled task is good. Paused and unscheduled
 * tasks don't count.
 */
export function sledSummary(rows: BoardRow[]): SledSummary {
  const counts = { overdue: 0, dueSoon: 0, noRecord: 0, unknown: 0, good: 0, notTracked: 0 };
  for (const row of rows) {
    if (row.status === "overdue") counts.overdue++;
    else if (row.status === "upcoming") counts.dueSoon++;
    else if (row.status === "no_record") counts.noRecord++;
    else if (row.status === "mileage_unknown") counts.unknown++;
    else if (row.status === "good") counts.good++;
    else counts.notTracked++;
  }
  const parts = [
    counts.overdue ? `${counts.overdue} overdue` : null,
    counts.dueSoon ? `${counts.dueSoon} due soon` : null,
    counts.noRecord ? `${counts.noRecord} no record yet` : null,
    counts.unknown ? `${counts.unknown} mileage unknown` : null,
  ].filter(Boolean);

  if (counts.overdue) return { tone: "red", label: "Overdue", detail: parts.join(" · "), counts };
  if (parts.length) {
    const label = counts.dueSoon ? "Due soon" : counts.noRecord ? "No record yet" : "Mileage unknown";
    return { tone: "yellow", label, detail: parts.join(" · "), counts };
  }
  if (counts.good)
    return { tone: "green", label: "Up to date", detail: counts.good === 1 ? "1 task up to date" : `All ${counts.good} up to date`, counts };
  return {
    tone: "neutral",
    label: "Nothing tracked",
    detail: counts.notTracked ? `${plural(counts.notTracked, "task")} not scheduled` : "No maintenance on the board yet",
    counts,
  };
}
