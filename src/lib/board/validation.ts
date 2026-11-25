import { z } from "zod";

import { checkbox, optionalText, pastOrToday, toNumber } from "@/lib/sleds/validation";
import { blankToUndefined } from "@/lib/sleds/validation";

import { intervalToDays } from "./describe";

const positive = (label: string, max: number) =>
  z.preprocess(
    toNumber,
    z
      .number({ error: `Enter a number for ${label}.` })
      .refine(Number.isFinite, { error: `Enter a number for ${label}.` })
      .gt(0, { error: `${label[0].toUpperCase()}${label.slice(1)} must be more than 0.` })
      .lt(max, { error: `That's more ${label} than SledWerx can store.` })
      .transform((n) => Math.round(n * 10) / 10)
      .optional(),
  );

const meter = (label: string, max: number) =>
  z.preprocess(
    toNumber,
    z
      .number({ error: `Enter a number for ${label}.` })
      .refine(Number.isFinite, { error: `Enter a number for ${label}.` })
      .min(0, { error: `${label[0].toUpperCase()}${label.slice(1)} can't be negative.` })
      .lt(max, { error: `That's more ${label} than SledWerx can store.` })
      .transform((n) => Math.round(n * 10) / 10)
      .optional(),
  );

/** The schedule of one board item. All parts are optional (none = not scheduled). */
export const scheduleSchema = z
  .object({
    intervalMi: positive("miles", 100_000_000),
    intervalHours: positive("engine hours", 10_000_000),
    intervalEvery: z.preprocess(
      toNumber,
      z
        .number({ error: "Enter a whole number." })
        .int({ error: "Enter a whole number." })
        .min(1, { error: "Enter at least 1." })
        .optional(),
    ),
    intervalUnit: z.enum(["days", "weeks", "months"]).default("months"),
    seasonal: checkbox,
    seasonMonth: z.preprocess(toNumber, z.number().int().min(1).max(12).optional()),
    seasonDay: z.preprocess(toNumber, z.number().int().min(1).max(31).optional()),
    paused: checkbox,
    baselineOn: z.preprocess(blankToUndefined, pastOrToday.optional()),
    baselineMi: meter("miles", 1_000_000),
    baselineHours: meter("engine hours", 100_000),
  })
  .superRefine((value, ctx) => {
    if (value.intervalEvery !== undefined) {
      const days = intervalToDays(value.intervalEvery, value.intervalUnit);
      if (days > 3650) ctx.addIssue({ code: "custom", path: ["intervalEvery"], message: "Use 10 years (3,650 days) or less." });
    }
    if (value.seasonal) {
      if (!value.seasonMonth || !value.seasonDay) {
        ctx.addIssue({ code: "custom", path: ["seasonDay"], message: "Choose the month and day it's due by." });
      } else {
        const lastDay = new Date(Date.UTC(2000, value.seasonMonth, 0)).getUTCDate();
        if (value.seasonDay > lastDay) ctx.addIssue({ code: "custom", path: ["seasonDay"], message: "That day isn't in that month." });
      }
    }
  })
  .transform((value) => ({
    interval_mi: value.intervalMi ?? null,
    interval_hours: value.intervalHours ?? null,
    interval_days: value.intervalEvery !== undefined ? intervalToDays(value.intervalEvery, value.intervalUnit) : null,
    season_due_month: value.seasonal ? (value.seasonMonth ?? null) : null,
    season_due_day: value.seasonal ? (value.seasonDay ?? null) : null,
    paused: value.paused,
    last_done_on: value.baselineOn ?? null,
    last_done_mi: value.baselineMi ?? null,
    last_done_hours: value.baselineHours ?? null,
  }));

export type ScheduleValues = z.output<typeof scheduleSchema>;

// ---------------------------------------------------------------------------
// Inspection & replacement tracking (Migration 13): what an item tracks, the
// check schedule, "replace as needed", season labels and both starting points.
// Combined with scheduleSchema (the replacement schedule, unchanged) by
// planSchema below.
// ---------------------------------------------------------------------------
const blankEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blankToUndefined, z.enum(values).optional());
const START = ["known", "tracking", "unknown"] as const;
const SEASON_KINDS = ["season", "preseason", "postseason"] as const;

export const trackingSchema = z
  .object({
    tracks: z.preprocess(blankToUndefined, z.enum(["replacement", "inspection", "both"]).default("replacement")),
    replaceAsNeeded: checkbox,
    seasonKind: blankEnum(SEASON_KINDS),
    // Absent (older forms): the starting point fields mean what they always did.
    replaceStart: blankEnum(START),
    inspectMi: positive("miles", 100_000_000),
    inspectHours: positive("engine hours", 10_000_000),
    inspectEvery: z.preprocess(
      toNumber,
      z
        .number({ error: "Enter a whole number." })
        .int({ error: "Enter a whole number." })
        .min(1, { error: "Enter at least 1." })
        .optional(),
    ),
    inspectUnit: z.enum(["days", "weeks", "months"]).default("months"),
    inspectSeasonal: checkbox,
    inspectSeasonKind: blankEnum(SEASON_KINDS),
    inspectSeasonMonth: z.preprocess(toNumber, z.number().int().min(1).max(12).optional()),
    inspectSeasonDay: z.preprocess(toNumber, z.number().int().min(1).max(31).optional()),
    inspectEachReading: checkbox,
    inspectStart: blankEnum(START),
    inspectBaselineOn: z.preprocess(blankToUndefined, pastOrToday.optional()),
    inspectBaselineMi: meter("miles", 1_000_000),
    inspectBaselineHours: meter("engine hours", 100_000),
  })
  .superRefine((value, ctx) => {
    if (value.tracks === "replacement") return;
    if (value.inspectEvery !== undefined && intervalToDays(value.inspectEvery, value.inspectUnit) > 3650) {
      ctx.addIssue({ code: "custom", path: ["inspectEvery"], message: "Use 10 years (3,650 days) or less." });
    }
    if (value.inspectSeasonal) {
      if (!value.inspectSeasonMonth || !value.inspectSeasonDay) {
        ctx.addIssue({ code: "custom", path: ["inspectSeasonDay"], message: "Choose the month and day it's due by." });
      } else if (value.inspectSeasonDay > new Date(Date.UTC(2000, value.inspectSeasonMonth, 0)).getUTCDate()) {
        ctx.addIssue({ code: "custom", path: ["inspectSeasonDay"], message: "That day isn't in that month." });
      }
    }
  });

type Start = (typeof START)[number] | undefined;

/** A starting point's kind: a tracking start is never shown as a replacement or a check. */
function baselineKind(start: Start, values: (number | string | undefined)[]): "known" | "tracking" | null {
  if (start === "unknown" || !values.some((v) => v !== undefined)) return null;
  return start === "tracking" ? "tracking" : "known";
}

/**
 * A board item's full schedule: the replacement schedule (scheduleSchema,
 * unchanged) and, with Migration 13, the check schedule. What isn't tracked is
 * cleared, except the replacement starting point of an inspection only item,
 * which is kept (Decision D: its history still counts, nothing is lost).
 */
export function planFrom(raw: Record<string, string | undefined>) {
  const replacement = scheduleSchema.safeParse(raw);
  const tracking = trackingSchema.safeParse(raw);
  if (!replacement.success || !tracking.success) {
    const issues = [...(replacement.success ? [] : replacement.error.issues), ...(tracking.success ? [] : tracking.error.issues)];
    // Only the schedules shown: a hidden schedule's fields are ignored.
    const tracks = raw.tracks === "inspection" || raw.tracks === "both" ? raw.tracks : "replacement";
    const shown = issues.filter((i) => {
      const inspect = String(i.path[0]).startsWith("inspect");
      return inspect ? tracks !== "replacement" : tracks !== "inspection" || i.path[0] === "paused";
    });
    if (shown.length) return { success: false as const, error: new z.ZodError(shown) };
  }
  const t = tracking.success ? tracking.data : trackingSchema.parse({});
  const r = replacement.success ? replacement.data : null;
  const inspects = t.tracks !== "replacement";
  const replaces = t.tracks !== "inspection";
  const unknown = (start: Start) => start === "unknown";

  const replaceFields =
    replaces && r
      ? {
          interval_mi: t.replaceAsNeeded ? null : r.interval_mi,
          interval_hours: t.replaceAsNeeded ? null : r.interval_hours,
          interval_days: t.replaceAsNeeded ? null : r.interval_days,
          season_due_month: t.replaceAsNeeded ? null : r.season_due_month,
          season_due_day: t.replaceAsNeeded ? null : r.season_due_day,
          last_done_on: unknown(t.replaceStart) ? null : r.last_done_on,
          last_done_mi: unknown(t.replaceStart) ? null : r.last_done_mi,
          last_done_hours: unknown(t.replaceStart) ? null : r.last_done_hours,
          replace_as_needed: t.replaceAsNeeded,
          season_kind: !t.replaceAsNeeded && r.season_due_month != null ? (t.seasonKind ?? "season") : null,
          replace_baseline_kind: baselineKind(t.replaceStart, [
            r.last_done_on ?? undefined,
            r.last_done_mi ?? undefined,
            r.last_done_hours ?? undefined,
          ]),
        }
      : {
          interval_mi: null,
          interval_hours: null,
          interval_days: null,
          season_due_month: null,
          season_due_day: null,
          replace_as_needed: false,
          season_kind: null,
        };
  const inspectKnown = !unknown(t.inspectStart);
  const inspectFields = inspects
    ? {
        inspect_interval_mi: t.inspectMi ?? null,
        inspect_interval_hours: t.inspectHours ?? null,
        inspect_interval_days: t.inspectEvery !== undefined ? intervalToDays(t.inspectEvery, t.inspectUnit) : null,
        inspect_season_month: t.inspectSeasonal ? (t.inspectSeasonMonth ?? null) : null,
        inspect_season_day: t.inspectSeasonal ? (t.inspectSeasonDay ?? null) : null,
        inspect_season_kind: t.inspectSeasonal ? (t.inspectSeasonKind ?? "season") : null,
        inspect_each_reading: t.inspectEachReading,
        inspect_baseline_on: inspectKnown ? (t.inspectBaselineOn ?? null) : null,
        inspect_baseline_mi: inspectKnown ? (t.inspectBaselineMi ?? null) : null,
        inspect_baseline_hours: inspectKnown ? (t.inspectBaselineHours ?? null) : null,
        inspect_baseline_kind: baselineKind(t.inspectStart, [t.inspectBaselineOn, t.inspectBaselineMi, t.inspectBaselineHours]),
      }
    : {
        inspect_interval_mi: null,
        inspect_interval_hours: null,
        inspect_interval_days: null,
        inspect_season_month: null,
        inspect_season_day: null,
        inspect_season_kind: null,
        inspect_each_reading: false,
        inspect_baseline_on: null,
        inspect_baseline_mi: null,
        inspect_baseline_hours: null,
        inspect_baseline_kind: null,
      };
  const paused = r?.paused ?? raw.paused === "on";
  return { success: true as const, data: { tracks: t.tracks, paused, ...replaceFields, ...inspectFields } };
}

export type PlanValues = Extract<ReturnType<typeof planFrom>, { success: true }>["data"];

export const newTaskSchema = z.object({ newTaskName: optionalText(120, "Task name") });
