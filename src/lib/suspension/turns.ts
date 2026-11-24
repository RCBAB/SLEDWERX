/**
 * Measurement / Turns (Migration 12): pure helpers shared by the pages, the
 * server actions and the tests.
 *
 * A turns adjustment is a signed change (+2, −1, +0.5), never a total. While a
 * Trail shows turns for a setting, its measurement is blank; documenting the
 * actual measurement on the same Trail replaces the turns shown.
 */
import { normalizeNumber } from "./validation";
import type { InputMethods, Snapshot, SuspensionSetting } from "./types";

/** One tap of − / +. */
export const TURNS_STEP = 0.5;
/** A single adjustment bigger than this asks for confirmation (it is still allowed). */
export const LARGE_TURNS = 20;

/** A documented measurement (or correction) on a Trail. */
export type MeasurementRecord = {
  value: string;
  /** The cumulative turns it documents. */
  cumulative: number | null;
  createdAt: string;
  createdByName: string;
};

/** One turns-tracked setting on one Trail. */
export type TrailTurns = {
  /** Turns since the last documented measurement (null: none outstanding). */
  cumulative: number | null;
  /** The measurement documented on this Trail, if any. */
  measurement: string | null;
  measuredAt: string | null;
  measurementNeeded: boolean;
  photoNeeded: boolean;
  /** The adjustment saved with this Trail (null: this Trail didn't turn it). */
  adjustment: number | null;
  /** Documented measurements and corrections on this Trail, oldest first. */
  records: MeasurementRecord[];
};

/** Turns-tracked settings of one Trail, keyed by setting id. */
export type TrailTurnsMap = Record<string, TrailTurns>;

/** Whether a setting can be adjusted in turns / measured. */
export const takesTurns = (methods: InputMethods) => methods !== "measurement";
export const takesMeasurement = (methods: InputMethods) => methods !== "turns";

/** Turns shown instead of a measurement (cumulative turns, nothing documented yet). */
export function turnsOutstanding(t: TrailTurns | undefined): t is TrailTurns & { cumulative: number } {
  return Boolean(t && t.cumulative !== null && t.measurement === null);
}

/** "+2.5 turns", "−1 turn", "0 turns". */
export function formatTurns(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const text = Math.abs(rounded)
    .toFixed(2)
    .replace(/\.?0+$/, "");
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${text} turn${Math.abs(rounded) === 1 ? "" : "s"}`;
}

/**
 * A typed turns amount: "+2", "-1", "−0.5", ".25", "2." -> a number with at
 * most two decimals; null if it isn't one (or has more decimals).
 */
export function parseTurns(input: string): number | null {
  const n = normalizeNumber(input);
  if (n === null) return null;
  if (n.includes(".") && n.split(".")[1].length > 2) return null;
  const value = Number(n);
  return Number.isFinite(value) && Math.abs(value) < 1_000_000 ? value : null;
}

/** The typed amount moved by one tap (±0.5), as text ("" counts as 0). */
export function stepTurns(current: string, direction: 1 | -1): string {
  const base = current.trim() === "" ? 0 : parseTurns(current);
  if (base === null) return current;
  const next = Math.round((base + direction * TURNS_STEP) * 100) / 100;
  return next > 0 ? `+${next}` : String(next);
}

/**
 * A Trail's actual values: what was saved, with a measurement documented on
 * that Trail in place of the (blank) turned value. Outstanding turns stay blank.
 */
export function currentValues(values: Snapshot, turns: TrailTurnsMap, settings: SuspensionSetting[]): Snapshot {
  const result: Snapshot = { ...values };
  for (const [id, t] of Object.entries(turns)) {
    if (t.measurement === null) continue;
    const setting = settings.find((s) => s.id === id);
    const entry = values[id];
    if (!setting && !entry) continue;
    result[id] = {
      value: t.measurement,
      name: entry?.name ?? setting!.name,
      zone: entry?.zone ?? setting!.zone,
      unit: setting ? setting.unit : (entry?.unit ?? null),
      type: "number",
    };
  }
  return result;
}

/**
 * What a Trail shows (View, History, Compare, disliked warnings): its actual
 * values, plus outstanding turns written as "+2.5 turns" in place of the blank
 * measurement. Two Trails with the same turns outstanding therefore compare equal.
 */
export function displayValues(values: Snapshot, turns: TrailTurnsMap, settings: SuspensionSetting[]): Snapshot {
  const result = currentValues(values, turns, settings);
  for (const [id, t] of Object.entries(turns)) {
    if (!turnsOutstanding(t)) continue;
    const setting = settings.find((s) => s.id === id);
    if (!setting) continue;
    result[id] = { value: formatTurns(t.cumulative), name: setting.name, zone: setting.zone, unit: null, type: "text" };
  }
  return result;
}

/** One setting's reminders on a Trail (Photo Needed only while photo uploads are on). */
export type SettingReminder = { settingId: string; name: string; measurementNeeded: boolean; photoNeeded: boolean };

/** The outstanding reminders of a Trail, in settings order. */
export function trailReminders(turns: TrailTurnsMap, settings: SuspensionSetting[], photoUploads: boolean): SettingReminder[] {
  return settings.flatMap((s) => {
    const t = turns[s.id];
    if (!t) return [];
    const measurementNeeded = t.measurementNeeded;
    const photoNeeded = photoUploads && t.photoNeeded;
    return measurementNeeded || photoNeeded ? [{ settingId: s.id, name: s.name, measurementNeeded, photoNeeded }] : [];
  });
}

/** "2 measurements · 1 photo needed". Empty when nothing is outstanding. */
export function reminderCounts(reminders: SettingReminder[]): string {
  const m = reminders.filter((r) => r.measurementNeeded).length;
  const p = reminders.filter((r) => r.photoNeeded).length;
  const parts = [m ? `${m} measurement${m === 1 ? "" : "s"} needed` : null, p ? `${p} photo${p === 1 ? "" : "s"} needed` : null].filter(
    Boolean,
  );
  return parts.join(" · ");
}
