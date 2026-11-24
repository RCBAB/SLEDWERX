import { describe, expect, it } from "vitest";

import { daysToInterval, intervalToDays, lastDoneLine, scheduleSummary, statusLine, STATUS_TONE } from "./describe";
import type { BoardRow } from "./types";
import { scheduleSchema } from "./validation";

const base: BoardRow = {
  planId: "p",
  taskId: "t",
  taskName: "Oil",
  intervalMi: null,
  intervalHours: null,
  intervalDays: null,
  seasonMonth: null,
  seasonDay: null,
  paused: false,
  baselineOn: null,
  baselineMi: null,
  baselineHours: null,
  version: 1,
  lastDoneSource: "service",
  lastDoneEntryId: "e",
  lastDoneOn: "2025-12-05",
  lastDoneMi: 1200,
  lastDoneHours: null,
  mileageUnknown: false,
  hoursUnknown: false,
  dueOn: null,
  remainingMi: null,
  remainingHours: null,
  remainingDays: null,
  status: "good",
  tracking: null,
};
const row = (change: Partial<BoardRow>): BoardRow => ({ ...base, ...change });

describe("board status lines", () => {
  it("says how far overdue, on every interval that is past due", () => {
    expect(statusLine(row({ status: "overdue", intervalMi: 1000, remainingMi: -100 }))).toBe("Overdue by 100 mi");
    expect(statusLine(row({ status: "overdue", remainingMi: -100, remainingDays: -10, intervalDays: 30 }))).toBe(
      "Overdue by 100 mi and 10 days",
    );
    expect(statusLine(row({ status: "overdue", remainingHours: -5 }))).toBe("Overdue by 5 hrs");
  });

  it("says what is left, whichever comes first", () => {
    expect(statusLine(row({ status: "upcoming", remainingMi: 20 }))).toBe("Due in 20 mi");
    expect(statusLine(row({ status: "upcoming", remainingMi: 340, remainingDays: 21 }))).toBe("Due in 340 mi or 21 days");
    expect(statusLine(row({ status: "good", remainingMi: 1000 }))).toBe("Next due in 1,000 mi");
    expect(statusLine(row({ status: "upcoming", remainingDays: 0 }))).toBe("Due today");
    expect(statusLine(row({ status: "upcoming", remainingDays: 1 }))).toBe("Due tomorrow");
    expect(statusLine(row({ status: "good", remainingDays: 200, dueOn: "2027-06-05" }))).toBe("Next due by Jun 5, 2027");
  });

  it("labels the neutral and needs-attention states", () => {
    expect(statusLine(row({ status: "unscheduled" }))).toBe("Not scheduled");
    expect(statusLine(row({ status: "paused" }))).toBe("Paused");
    expect(statusLine(row({ status: "no_record" }))).toBe("No record yet");
    expect(statusLine(row({ status: "mileage_unknown" }))).toBe("Mileage unknown");
    expect([STATUS_TONE.overdue, STATUS_TONE.upcoming, STATUS_TONE.good, STATUS_TONE.unscheduled]).toEqual([
      "red",
      "yellow",
      "green",
      "neutral",
    ]);
  });
});

describe("last done", () => {
  it("shows the recorded mileage", () => {
    expect(lastDoneLine(row({ lastDoneHours: 95 }))).toBe("Last done Dec 5, 2025 · 1,200 mi · 95 hrs");
  });

  it("never estimates mileage: unrecorded mileage says so", () => {
    expect(lastDoneLine(row({ lastDoneMi: null, intervalMi: 1000, mileageUnknown: true }))).toBe(
      "Last done Dec 5, 2025 · mileage unknown",
    );
  });

  it("names the starting point and records that don't exist yet", () => {
    expect(lastDoneLine(row({ lastDoneSource: "baseline", lastDoneMi: null, intervalDays: 30 }))).toBe(
      "Done before SledWerx Dec 5, 2025",
    );
    expect(lastDoneLine(row({ lastDoneSource: null }))).toBe("Never done in SledWerx");
  });
});

describe("schedules", () => {
  it("summarizes any combination", () => {
    expect(scheduleSummary(row({ intervalMi: 1000, intervalDays: 360 }))).toBe("Every 1,000 mi or 12 months");
    expect(scheduleSummary(row({ intervalHours: 50, seasonMonth: 11, seasonDay: 1 }))).toBe("Every 50 hrs · once a season by Nov 1");
    expect(scheduleSummary(row({ seasonMonth: 11, seasonDay: 1 }))).toBe("Once a season by Nov 1");
    expect(scheduleSummary(row({ intervalDays: 14 }))).toBe("Every 2 weeks");
    expect(scheduleSummary(row({}))).toBe("Not scheduled");
  });

  it("converts days, weeks and months (a month is 30 days)", () => {
    expect(daysToInterval(360)).toEqual({ every: 12, unit: "months" });
    expect(daysToInterval(14)).toEqual({ every: 2, unit: "weeks" });
    expect(daysToInterval(10)).toEqual({ every: 10, unit: "days" });
    expect(intervalToDays(6, "months")).toBe(180);
    expect(intervalToDays(3, "weeks")).toBe(21);
  });

  it("validates and converts a schedule for the database", () => {
    expect(scheduleSchema.parse({ intervalMi: "1,000", intervalEvery: "12", intervalUnit: "months" })).toMatchObject({
      interval_mi: 1000,
      interval_days: 360,
      season_due_month: null,
      paused: false,
    });
    expect(scheduleSchema.parse({ seasonal: "on", seasonMonth: "11", seasonDay: "1" })).toMatchObject({
      season_due_month: 11,
      season_due_day: 1,
      interval_mi: null,
    });
    // Unscheduled is allowed.
    expect(scheduleSchema.parse({})).toMatchObject({ interval_mi: null, interval_hours: null, interval_days: null });
  });

  it.each([
    ["zero miles", { intervalMi: "0" }],
    ["an impossible season day", { seasonal: "on", seasonMonth: "2", seasonDay: "30" }],
    ["a season without a day", { seasonal: "on", seasonMonth: "11", seasonDay: "" }],
    ["more than 10 years", { intervalEvery: "122", intervalUnit: "months" }],
    ["a future starting date", { baselineOn: "2999-01-01" }],
    ["negative starting miles", { baselineMi: "-5" }],
  ])("rejects %s", (_label, input) => {
    expect(scheduleSchema.safeParse(input).success).toBe(false);
  });

  it("ignores season fields unless seasonal is chosen", () => {
    expect(scheduleSchema.parse({ seasonMonth: "11", seasonDay: "1" }).season_due_month).toBeNull();
  });
});
