import { z } from "zod";

import { optionalText, pastOrToday, requiredText, toNumber } from "@/lib/sleds/validation";

import { MAX_SETTING_VALUE, RIDE_RATINGS, SUSPENSION_ZONES, TRAIL_CONDITIONS, VALUE_TYPES, type SettingValueType } from "./types";

/** What the database accepts for a number setting (Migration 7). */
export const NUMBER_VALUE = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * A typed number in the form the database accepts: "+2" -> "2", ".5" -> "0.5",
 * "-.5" -> "-0.5", "5." -> "5", "−3" (typographic minus) -> "-3", "1 000" -> "1000".
 * Returns null if it isn't a number.
 */
export function normalizeNumber(input: string): string | null {
  let text = input.trim().replace(/[\s ]/g, "").replace(/^[−–]/, "-");
  if (text.startsWith("+")) text = text.slice(1);
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  if (!/[0-9]/.test(text)) return null;
  if (text.startsWith(".")) text = `0${text}`;
  if (text.endsWith(".")) text = text.slice(0, -1);
  text = text.replace(/^0+(?=\d)/, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  // "-0" and "-0.0" are just zero.
  const signed = negative && /[1-9]/.test(text) ? `-${text}` : text;
  return NUMBER_VALUE.test(signed) ? signed : null;
}

export type ValueCheck = { ok: true; value: string | null } | { ok: false; error: string };

/** Checks one typed value for a setting. Blank means "no value". */
export function checkSettingValue(type: SettingValueType, raw: unknown, settingName: string): ValueCheck {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: true, value: null };
  if (type === "number") {
    const value = normalizeNumber(text);
    if (value === null) return { ok: false, error: `Enter a number for ${settingName}.` };
    if (value.length > MAX_SETTING_VALUE) return { ok: false, error: "That number is too long." };
    return { ok: true, value };
  }
  if (text.length > MAX_SETTING_VALUE) {
    return { ok: false, error: `Values must be ${MAX_SETTING_VALUE} characters or fewer.` };
  }
  return { ok: true, value: text };
}

export const settingSchema = z.object({
  name: requiredText(80, "Name"),
  zone: z.enum(SUSPENSION_ZONES, { error: "Choose where it is on the sled." }),
  valueType: z.enum(VALUE_TYPES, { error: "Choose number or text." }),
  unit: optionalText(20, "Unit"),
  notes: optionalText(2000, "Notes"),
});

/** A ride evaluation: rating, any trail conditions, ride date, optional day's high (degF) and notes. */
export const feedbackSchema = z.object({
  rating: z.enum(RIDE_RATINGS, { error: "Choose how it rode." }),
  conditions: z
    .array(z.enum(TRAIL_CONDITIONS, { error: "Choose trail conditions from the list." }))
    .max(TRAIL_CONDITIONS.length)
    .transform((list) => TRAIL_CONDITIONS.filter((c) => list.includes(c))),
  riddenOn: pastOrToday,
  highTemp: z.preprocess(
    toNumber,
    z
      .number({ error: "Enter the temperature as a whole number of °F." })
      .int({ error: "Enter the temperature as a whole number of °F." })
      .min(-60, { error: "That's colder than SledWerx can store (−60 °F)." })
      .max(120, { error: "That's warmer than SledWerx can store (120 °F)." })
      .optional(),
  ),
  note: optionalText(2000, "Notes"),
});

const meter = (label: string, max: number) =>
  z.preprocess(
    toNumber,
    z
      .number({ error: `Enter the ${label} as a number.` })
      .refine(Number.isFinite, { error: `Enter the ${label} as a number.` })
      .min(0, { error: `The ${label} can't be negative.` })
      .lt(max, { error: `That's more ${label} than SledWerx can store.` })
      .transform((n) => Math.round(n * 10) / 10)
      .optional(),
  );

/** The note and the copied meter values of an adjustment or restore. */
export const adjustmentSchema = z.object({
  note: optionalText(2000, "Note"),
  odometer: meter("mileage", 1_000_000),
  engineHours: meter("engine hours", 100_000),
  idempotencyKey: z.uuid({ error: "Reload the page and try again." }),
});

export const uuidSchema = z.uuid();
