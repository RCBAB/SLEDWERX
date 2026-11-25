"use client";

import { ClipboardCheck, OctagonAlert, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { STATUS_TONE } from "@/lib/board/describe";
import {
  CHECK_TONE,
  canRecordReplacement,
  checkLine,
  checkScheduleSummary,
  checkedLine,
  itemTone,
  replaceLine,
  replaceScheduleSummary,
  replacedLine,
  trackingChips,
  type Tone,
} from "@/lib/board/tracking";
import type { BoardRow, BoardTracking } from "@/lib/board/types";

import { TONE_TEXT } from "./complete-form";

type Tracked = BoardRow & { tracking: BoardTracking };

/**
 * The two schedules of an item that tracks inspections (Maintenance Board and
 * Garage Board cards). Replacement-only items keep their existing lines.
 */
export function TrackingLines({ row, big, showSchedule }: { row: Tracked; big?: boolean; showSchedule?: boolean }) {
  const t = row.tracking;
  const both = t.tracks === "both";
  const checkTone: Tone = t.inspectStatus ? CHECK_TONE[t.inspectStatus] : "neutral";
  const replaceTone: Tone = t.replaceStatus && t.replaceStatus !== "as_needed" ? STATUS_TONE[t.replaceStatus] : "neutral";
  const status = big ? "text-base" : "text-sm";
  const detail = big ? "text-sm" : "text-xs";
  return (
    <div className="space-y-1">
      {t.needsReplacement ? <NeedsReplacementBadge big={big} /> : null}
      <div>
        <p className={cn("font-semibold", status, TONE_TEXT[checkTone])} data-testid="check-status">
          {checkLine(row)}
        </p>
        <p className={cn("text-muted", detail)} data-testid="check-last">
          {checkedLine(row)}
        </p>
      </div>
      {both ? (
        <div>
          <p className={cn("font-semibold", status, TONE_TEXT[replaceTone])} data-testid="replace-status">
            {replaceLine(row)}
          </p>
          <p className={cn("text-muted", detail)} data-testid="replace-last">
            {replacedLine(row)}
          </p>
        </div>
      ) : null}
      {showSchedule ? (
        <p className={cn("text-muted", detail)}>
          {checkScheduleSummary(row)}
          {both ? ` · ${replaceScheduleSummary(row)}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function NeedsReplacementBadge({ big }: { big?: boolean }) {
  return (
    <p
      data-testid="needs-replacement"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-red-500/20 px-2.5 py-0.5 font-bold uppercase tracking-wide text-red-200 ring-1 ring-red-500/60",
        big ? "text-sm" : "text-xs",
      )}
    >
      <OctagonAlert aria-hidden className="size-3.5" />
      Needs Replacement
    </p>
  );
}

const CHIP_TONE: Record<Tone, string> = {
  red: "bg-red-500/20 text-red-200 ring-red-500/50",
  yellow: "bg-amber-400/15 text-amber-200 ring-amber-400/40",
  green: "bg-emerald-500/15 text-emerald-200 ring-emerald-500/40",
  neutral: "bg-white/5 text-muted ring-white/15",
};

/** Compact view: only what needs attention, as chips ("Needs Replacement", "Check due"). */
export function TrackingChips({ row, big }: { row: Tracked; big?: boolean }) {
  const chips = trackingChips(row);
  if (!chips.length) {
    const tone = itemTone(row);
    return <span className={TONE_TEXT[tone]}>{tone === "green" ? "Good" : checkLine(row)}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5" data-testid="tracking-chips">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={cn("inline-flex rounded-full px-2.5 py-0.5 font-semibold ring-1", big ? "text-sm" : "text-xs", CHIP_TONE[chip.tone])}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}

/** Checked and Replaced (any time, due or not). Replaced appears on inspection only items once flagged. */
export function TrackingButtons({
  row,
  on,
  big,
  onChecked,
  onReplaced,
  className,
}: {
  row: Tracked;
  /** The buttons' container: a row by default (full width under the text on phones). */
  className?: string;
  /** " on Blue Cat" for the Garage Board's accessible names. */
  on?: string;
  big?: boolean;
  onChecked: () => void;
  onReplaced: () => void;
}) {
  const size = big ? "lg" : "md";
  const height = big ? "h-14" : "h-11";
  return (
    <div className={cn("flex gap-2 [&>button]:flex-1", className)}>
      <Button
        type="button"
        size={size}
        className={cn(height, "px-4")}
        aria-label={`Checked: ${row.taskName}${on ?? ""}`}
        onClick={onChecked}
      >
        <ClipboardCheck aria-hidden className="size-4 max-[359px]:hidden" />
        Checked
      </Button>
      {canRecordReplacement(row) ? (
        <Button
          type="button"
          variant="secondary"
          size={size}
          className={cn(height, "px-4")}
          aria-label={`Replaced: ${row.taskName}${on ?? ""}`}
          onClick={onReplaced}
        >
          <Wrench aria-hidden className="size-4 max-[359px]:hidden" />
          Replaced
        </Button>
      ) : null}
    </div>
  );
}
