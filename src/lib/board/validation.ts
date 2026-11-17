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

export const newTaskSchema = z.object({ newTaskName: optionalText(120, "Task name") });
