"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

import type { SuspensionActionState } from "@/app/garage/suspension-actions";
import { cn } from "@/components/ui/cn";
import { FEEDBACK_LABEL, type FeedbackRating } from "@/lib/suspension/types";

const subscribe = () => () => {};

/**
 * A timestamp as a date in the viewer's own time zone ("Nov 12, 2026").
 * Rendered in UTC on the server, then in local time once in the browser.
 */
export function LocalDate({ value, withTime = false }: { value: string; withTime?: boolean }) {
  const options: Intl.DateTimeFormatOptions = withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  const text = useSyncExternalStore(
    subscribe,
    () => new Date(value).toLocaleString("en-US", options),
    () => new Date(value).toLocaleString("en-US", { ...options, timeZone: "UTC" }),
  );
  return <time dateTime={value}>{text}</time>;
}

/** Runs a server action from a button: busy flag, and the error to show. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<SuspensionActionState>, after?: (result: SuspensionActionState) => void) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) setError(result.error);
      if (result.ok) after?.(result);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export function SectionTitle({ id, children, action }: { id?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="font-display text-2xl font-bold uppercase tracking-wide">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Panel({ children, className, ...props }: { children: ReactNode; className?: string } & React.ComponentProps<"div">) {
  return (
    <div {...props} className={cn("rounded-2xl border border-white/10 bg-surface/70 p-5", className)}>
      {children}
    </div>
  );
}

const RATING_STYLE: Record<FeedbackRating, string> = {
  improved: "bg-emerald-500/15 text-emerald-200 ring-emerald-500/40",
  worse: "bg-red-500/15 text-red-200 ring-red-500/40",
  no_change: "bg-white/5 text-muted ring-white/15",
};

export function RatingBadge({ rating, className }: { rating: FeedbackRating; className?: string }) {
  return (
    <span
      data-testid="feedback-rating"
      data-rating={rating}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ring-1",
        RATING_STYLE[rating],
        className,
      )}
    >
      {FEEDBACK_LABEL[rating]}
    </span>
  );
}

/** The small "Active" marker on a setup. */
export function ActiveBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="active-badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[0.7rem] font-bold uppercase tracking-wider text-accent-hot ring-1 ring-accent/50",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-accent-hot" />
      Active
    </span>
  );
}
