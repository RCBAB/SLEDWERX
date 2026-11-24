import { describe, expect, it } from "vitest";

import { sameValues } from "./warnings";
import {
  currentValues,
  displayValues,
  formatTurns,
  parseTurns,
  reminderCounts,
  stepTurns,
  trailReminders,
  turnsOutstanding,
  type TrailTurns,
} from "./turns";
import type { Snapshot, SuspensionSetting } from "./types";

const setting = (
  id: string,
  name: string,
  inputMethods: SuspensionSetting["inputMethods"],
  unit: string | null = "in",
): SuspensionSetting => ({
  id,
  name,
  zone: "rear_rear_shock",
  valueType: "number",
  inputMethods,
  unit,
  position: 0,
  notes: null,
  version: 1,
  photos: [],
});
const PRE = setting("pre", "Preload", "both");
const COL = setting("col", "Collar", "turns", null);
const COMP = setting("comp", "Compression", "measurement", "clicks");
const settings = [PRE, COL, COMP];

const turns = (over: Partial<TrailTurns>): TrailTurns => ({
  cumulative: null,
  measurement: null,
  measuredAt: null,
  measurementNeeded: false,
  photoNeeded: false,
  adjustment: null,
  records: [],
  ...over,
});
const values: Snapshot = { comp: { value: "12", name: "Compression", zone: "rear_rear_shock", unit: "clicks", type: "number" } };

describe("turns amounts", () => {
  it("are written signed, with turn / turns", () => {
    expect(formatTurns(2.5)).toBe("+2.5 turns");
    expect(formatTurns(-1)).toBe("−1 turn");
    expect(formatTurns(1)).toBe("+1 turn");
    expect(formatTurns(0)).toBe("0 turns");
    expect(formatTurns(0.25)).toBe("+0.25 turns");
    expect(formatTurns(-0.5)).toBe("−0.5 turns");
  });

  it("are typed with up to two decimals, either minus sign", () => {
    expect(parseTurns("+2")).toBe(2);
    expect(parseTurns("−0.5")).toBe(-0.5);
    expect(parseTurns("-.25")).toBe(-0.25);
    expect(parseTurns("2.")).toBe(2);
    expect(parseTurns("0.125")).toBeNull();
    expect(parseTurns("two")).toBeNull();
    expect(parseTurns("")).toBeNull();
  });

  it("step by half a turn per tap", () => {
    expect(stepTurns("", 1)).toBe("+0.5");
    expect(stepTurns("+0.5", 1)).toBe("+1");
    expect(stepTurns("", -1)).toBe("-0.5");
    expect(stepTurns("+0.5", -1)).toBe("0");
    expect(stepTurns("1.25", 1)).toBe("+1.75");
    expect(stepTurns("x", 1)).toBe("x");
  });
});

describe("a Trail's values", () => {
  it("blank while turns are outstanding; the documented measurement once recorded", () => {
    expect(turnsOutstanding(turns({ cumulative: 2.5 }))).toBe(true);
    expect(turnsOutstanding(turns({ cumulative: 0 }))).toBe(true);
    expect(turnsOutstanding(turns({ cumulative: 2.5, measurement: "11.5" }))).toBe(false);
    expect(turnsOutstanding(undefined)).toBe(false);

    const outstanding = { pre: turns({ cumulative: 2.5, measurementNeeded: true }) };
    expect(currentValues(values, outstanding, settings).pre).toBeUndefined();
    expect(displayValues(values, outstanding, settings).pre).toMatchObject({ value: "+2.5 turns", unit: null, type: "text" });

    const measured = { pre: turns({ cumulative: 2.5, measurement: "11.5" }) };
    expect(currentValues(values, measured, settings).pre).toMatchObject({ value: "11.5", unit: "in", type: "number" });
    expect(displayValues(values, measured, settings).pre?.value).toBe("11.5");
    expect(displayValues(values, measured, settings).comp?.value).toBe("12");
  });

  it("compare equal only with the same turns outstanding", () => {
    const a = displayValues(values, { pre: turns({ cumulative: 2.5 }) }, settings);
    const b = displayValues(values, { pre: turns({ cumulative: 2.5 }) }, settings);
    const c = displayValues(values, { pre: turns({ cumulative: 3 }) }, settings);
    const d = displayValues(values, {}, settings);
    expect(sameValues(a, b)).toBe(true);
    expect(sameValues(a, c)).toBe(false);
    expect(sameValues(a, d)).toBe(false);
  });
});

describe("reminders", () => {
  const map = { pre: turns({ cumulative: 2.5, measurementNeeded: true, photoNeeded: true }), col: turns({ cumulative: 3 }) };

  it("list each setting needing a measurement or photo", () => {
    expect(trailReminders(map, settings, true)).toEqual([
      { settingId: "pre", name: "Preload", measurementNeeded: true, photoNeeded: true },
    ]);
    expect(reminderCounts(trailReminders(map, settings, true))).toBe("1 measurement needed · 1 photo needed");
  });

  it("hide Photo Needed while photo uploads are off", () => {
    expect(trailReminders(map, settings, false)).toEqual([
      { settingId: "pre", name: "Preload", measurementNeeded: true, photoNeeded: false },
    ]);
    expect(reminderCounts(trailReminders(map, settings, false))).toBe("1 measurement needed");
    const photoOnly = { pre: turns({ measurement: "11.5", cumulative: 2.5, photoNeeded: true }) };
    expect(trailReminders(photoOnly, settings, false)).toEqual([]);
  });

  it("are empty when nothing is outstanding", () => {
    expect(trailReminders({}, settings, true)).toEqual([]);
    expect(reminderCounts([])).toBe("");
  });
});
