import { describe, expect, it } from "vitest";

import { sledSummary } from "@/lib/garage/summary";

import { lastDoneLine, lastDoneShort } from "./describe";

import {
  canRecordReplacement,
  checkLine,
  checkScheduleSummary,
  checkedLine,
  checksDue,
  itemState,
  itemTone,
  quickCheckItems,
  replaceLine,
  replaceScheduleSummary,
  replacedLine,
  trackingChips,
  tracksInspection,
} from "./tracking";
import type { BoardRow, BoardTracking } from "./types";
import { planFrom } from "./validation";

const tracking: BoardTracking = {
  tracks: "inspection",
  replaceAsNeeded: false,
  seasonKind: null,
  replaceBaselineKind: null,
  replaceStatus: null,
  inspect: {
    intervalMi: null,
    intervalHours: null,
    intervalDays: 30,
    seasonMonth: null,
    seasonDay: null,
    seasonKind: null,
    eachReading: false,
    baselineOn: null,
    baselineMi: null,
    baselineHours: null,
    baselineKind: null,
  },
  inspectStatus: "good",
  lastCheckedSource: "check",
  lastCheckedOn: "2026-11-03",
  lastCheckedMi: 1200,
  lastCheckedHours: null,
  lastCheckOutcome: "good",
  needsReplacement: false,
  inspectDueOn: "2026-12-03",
  inspectDueMi: null,
  inspectRemainingMi: null,
  inspectRemainingHours: null,
  inspectRemainingDays: 12,
  inspectDueOnReading: false,
  itemRank: 2,
  componentMi: null,
  componentSince: null,
};

const base: BoardRow = {
  planId: "p",
  taskId: "t",
  taskName: "Belt",
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
  lastDoneSource: null,
  lastDoneEntryId: null,
  lastDoneOn: null,
  lastDoneMi: null,
  lastDoneHours: null,
  mileageUnknown: false,
  hoursUnknown: false,
  dueOn: null,
  remainingMi: null,
  remainingHours: null,
  remainingDays: null,
  status: "unscheduled",
  tracking,
};

type Tracked = BoardRow & { tracking: BoardTracking };
const row = (change: Partial<BoardTracking> = {}, other: Partial<BoardRow> = {}): Tracked =>
  ({ ...base, ...other, tracking: { ...tracking, ...change, inspect: { ...tracking.inspect, ...change.inspect } } }) as Tracked;
const replacementOnly = (status: BoardRow["status"]): BoardRow => ({
  ...base,
  taskName: "Oil",
  status,
  tracking: { ...tracking, tracks: "replacement", inspectStatus: null, replaceStatus: status },
});

describe("which items use Checked / Replaced (Decision E)", () => {
  it("replacement-only items keep Done; inspection items get Checked", () => {
    expect(tracksInspection(replacementOnly("good"))).toBe(false);
    expect(tracksInspection({ ...base, tracking: null })).toBe(false);
    expect(tracksInspection(row())).toBe(true);
    expect(tracksInspection(row({ tracks: "both" }))).toBe(true);
  });

  it("Replaced appears on items tracking replacement, or inspection only items once flagged", () => {
    expect(canRecordReplacement(row({ tracks: "both" }))).toBe(true);
    expect(canRecordReplacement(row())).toBe(false);
    expect(canRecordReplacement(row({ needsReplacement: true }))).toBe(true);
  });
});

describe("the check schedule's lines", () => {
  it("say when the next check is due", () => {
    expect(checkLine(row())).toBe("Next check in 12 days");
    expect(checkLine(row({ inspectStatus: "upcoming", inspectRemainingDays: 3 }))).toBe("Check due in 3 days");
    expect(checkLine(row({ inspectStatus: "upcoming", inspectRemainingMi: 40, inspectRemainingDays: null }))).toBe("Check due in 40 mi");
    expect(checkLine(row({ inspectStatus: "upcoming", inspectRemainingDays: 0 }))).toBe("Check due today");
    expect(checkLine(row({ inspectStatus: "overdue", inspectRemainingDays: -4 }))).toBe("Check overdue by 4 days");
    expect(checkLine(row({ inspectStatus: "overdue", inspectRemainingMi: -40, inspectRemainingDays: -4 }))).toBe(
      "Check overdue by 40 mi and 4 days",
    );
    expect(checkLine(row({ inspectStatus: "initial_check" }))).toBe("Initial check needed");
    expect(checkLine(row({ inspectStatus: "due", inspectDueOnReading: true }))).toBe("Check due: mileage updated");
    expect(checkLine(row({ inspectStatus: "paused" }))).toBe("Paused");
    expect(checkLine(row({ inspectStatus: "unscheduled" }))).toBe("Check not scheduled");
  });

  it("include Every Mileage Update", () => {
    const each = { ...tracking.inspect, eachReading: true, intervalDays: null };
    expect(checkLine(row({ inspect: each, inspectRemainingDays: null }))).toBe("Check at the next mileage update");
    expect(checkLine(row({ inspect: { ...each, intervalDays: 30 } }))).toBe("Next check in 12 days, or at the next mileage update");
  });

  it("say what the check counts from, with the outcome", () => {
    expect(checkedLine(row())).toBe("Last checked Nov 3, 2026 · 1,200 mi · Good");
    expect(checkedLine(row({ lastCheckOutcome: "needs_replacement" }))).toBe("Last checked Nov 3, 2026 · 1,200 mi · Needs Replacement");
    // Inspection only items use "Last checked" throughout, and say when a replacement satisfied it.
    expect(checkedLine(row({ lastCheckedSource: "replacement", lastCheckOutcome: null }))).toBe(
      "Last checked Nov 3, 2026 · 1,200 mi · satisfied by a replacement",
    );
    expect(checkedLine(row({ lastCheckedSource: "service", lastCheckOutcome: null }))).toBe(
      "Last checked Nov 3, 2026 · 1,200 mi · satisfied by a replacement",
    );
    const own = { ...tracking.inspect, baselineOn: "2026-11-03", baselineMi: 1200, baselineKind: "known" as const };
    expect(checkedLine(row({ lastCheckedSource: "baseline", inspect: own }))).toBe("Last checked Nov 3, 2026 · 1,200 mi · before SledWerx");
    expect(checkedLine(row({ lastCheckedSource: "baseline" }))).toBe(
      "Last checked Nov 3, 2026 · 1,200 mi · satisfied by a replacement before SledWerx",
    );
    expect(checkedLine(row({ lastCheckedSource: "tracking", lastCheckedMi: null }))).toBe("Tracking since Nov 3, 2026");
    expect(checkedLine(row({ lastCheckedSource: null }))).toBe("Never checked");
  });
});

describe("the replacement schedule's lines (Both)", () => {
  const both = (change: Partial<BoardTracking>, other: Partial<BoardRow> = {}) => row({ tracks: "both", ...change }, other);

  it("say when it's due, or as needed", () => {
    expect(replaceLine(both({ replaceStatus: "good" }, { status: "good", remainingMi: 800 }))).toBe("Replace in 800 mi");
    expect(replaceLine(both({ replaceStatus: "upcoming" }, { status: "upcoming", remainingMi: 20 }))).toBe("Replace in 20 mi");
    expect(replaceLine(both({ replaceStatus: "overdue" }, { status: "overdue", remainingMi: -50 }))).toBe("Replacement overdue by 50 mi");
    expect(replaceLine(both({ replaceStatus: "as_needed", replaceAsNeeded: true }))).toBe("Replace as needed");
    expect(replaceLine(both({ replaceStatus: "no_record" }, { status: "no_record" }))).toBe("No replacement recorded");
  });

  it("say when it was replaced and the miles on it; a tracking start is never a replacement", () => {
    const replaced = both({ componentMi: 1240 }, { lastDoneSource: "service", lastDoneOn: "2026-10-01", lastDoneMi: 1200 });
    expect(replacedLine(replaced)).toBe("Replaced Oct 1, 2026 · 1,200 mi · 1,240 mi on it");
    const tracked = both({ componentMi: 300, replaceBaselineKind: "tracking" }, { lastDoneSource: "baseline", lastDoneOn: "2026-11-01" });
    expect(replacedLine(tracked)).toBe("Tracking since Nov 1, 2026 · 300 mi since");
    expect(replacedLine(both({}))).toBe("Never replaced in SledWerx");
  });

  it("summarise both schedules, with the season label (Decision B)", () => {
    const r = both(
      { inspect: { ...tracking.inspect, intervalDays: null, seasonMonth: 12, seasonDay: 1, seasonKind: "preseason", eachReading: true } },
      { intervalMi: 2000 },
    );
    expect(checkScheduleSummary(r)).toBe("Check: preseason by Dec 1 · every mileage update");
    expect(replaceScheduleSummary(r)).toBe("Replace: every 2,000 mi");
    expect(replaceScheduleSummary(both({ replaceAsNeeded: true }))).toBe("Replace: as needed");
    expect(checkScheduleSummary(row())).toBe("Check: every 1 month");
  });
});

describe("Needs Replacement and the card's colour", () => {
  it("is red, first, until replaced", () => {
    expect(itemTone(row({ needsReplacement: true }))).toBe("red");
    expect(itemState(row({ needsReplacement: true }))).toBe("needs_replacement");
    expect(trackingChips(row({ needsReplacement: true }))[0]).toEqual({ label: "Needs Replacement", tone: "red" });
  });

  it("follows the more urgent schedule", () => {
    expect(itemTone(row())).toBe("green");
    expect(itemTone(row({ tracks: "both", replaceStatus: "overdue" }))).toBe("red");
    expect(itemTone(row({ tracks: "both", inspectStatus: "upcoming", replaceStatus: "good" }))).toBe("yellow");
    expect(itemTone(row({ tracks: "both", inspectStatus: "unscheduled", replaceStatus: "as_needed" }))).toBe("neutral");
    expect(itemState(row({ tracks: "both", inspectStatus: "initial_check", replaceStatus: "upcoming" }))).toBe("check_due");
  });

  it("shows a replacement-only tracking start as tracking, never as done", () => {
    const started = {
      ...replacementOnly("good"),
      lastDoneSource: "baseline" as const,
      lastDoneOn: "2026-11-25",
      lastDoneMi: 3000,
      tracking: { ...tracking, tracks: "replacement" as const, replaceBaselineKind: "tracking" as const },
    };
    expect(lastDoneLine(started)).toBe("Tracking since Nov 25, 2026 · 3,000 mi");
    expect(lastDoneShort(started)).toBe("Tracking since Nov 25, 2026 · 3,000 mi");
    const known = { ...started, tracking: { ...started.tracking, replaceBaselineKind: null } };
    expect(lastDoneLine(known)).toBe("Done before SledWerx Nov 25, 2026 · 3,000 mi");
  });

  it("leaves replacement-only items exactly as before", () => {
    expect(itemTone(replacementOnly("overdue"))).toBe("red");
    expect(itemState(replacementOnly("no_record"))).toBe("no_record");
  });

  it("counts on the sled summary", () => {
    expect(sledSummary([row({ needsReplacement: true }), replacementOnly("good")])).toMatchObject({
      tone: "red",
      label: "Needs replacement",
      detail: "1 needs replacement",
    });
    expect(sledSummary([row({ inspectStatus: "initial_check" }), row({ inspectStatus: "due" })])).toMatchObject({
      tone: "yellow",
      label: "Check due",
      detail: "2 checks due",
    });
    expect(sledSummary([row(), replacementOnly("good")]).detail).toBe("All 2 up to date");
  });
});

describe("Quick Check (Decision F)", () => {
  const rows = [
    row({ inspectStatus: "upcoming" }, { taskId: "soon", taskName: "Soon" }),
    row({ inspectStatus: "overdue" }, { taskId: "late", taskName: "Late" }),
    row({ inspectStatus: "good" }, { taskId: "fine", taskName: "Fine" }),
    row({ inspectStatus: "initial_check" }, { taskId: "new", taskName: "New" }),
    replacementOnly("overdue"),
  ];

  it("lists due inspections first, then those due soon (set to Skip)", () => {
    expect(quickCheckItems(rows).map((i) => [i.taskId, i.due])).toEqual([
      ["late", true],
      ["new", true],
      ["soon", false],
    ]);
    expect(checksDue(rows)).toBe(2);
    expect(checksDue([replacementOnly("overdue")])).toBe(0);
  });
});

describe("the schedule dialog's values", () => {
  it("keeps a replacement-only schedule as before", () => {
    const plan = planFrom({ intervalMi: "1,000", baselineOn: "2026-01-01", baselineMi: "500" });
    expect(plan.success && plan.data).toMatchObject({
      tracks: "replacement",
      interval_mi: 1000,
      last_done_on: "2026-01-01",
      last_done_mi: 500,
      replace_baseline_kind: "known",
      inspect_interval_days: null,
      inspect_each_reading: false,
    });
  });

  it("saves both schedules, season labels and starting points", () => {
    const plan = planFrom({
      tracks: "both",
      intervalMi: "2000",
      replaceStart: "tracking",
      baselineOn: "2026-11-01",
      baselineMi: "1500",
      inspectEvery: "1",
      inspectUnit: "months",
      inspectSeasonal: "on",
      inspectSeasonKind: "postseason",
      inspectSeasonMonth: "4",
      inspectSeasonDay: "15",
      inspectEachReading: "on",
      inspectStart: "unknown",
      inspectBaselineOn: "2026-10-01",
    });
    expect(plan.success && plan.data).toMatchObject({
      tracks: "both",
      interval_mi: 2000,
      replace_baseline_kind: "tracking",
      last_done_mi: 1500,
      inspect_interval_days: 30,
      inspect_season_month: 4,
      inspect_season_day: 15,
      inspect_season_kind: "postseason",
      inspect_each_reading: true,
      inspect_baseline_on: null,
      inspect_baseline_kind: null,
    });
  });

  it("Replace as needed clears the replacement intervals", () => {
    const plan = planFrom({ tracks: "both", replaceAsNeeded: "on", intervalMi: "2000", inspectMi: "100" });
    expect(plan.success && plan.data).toMatchObject({ replace_as_needed: true, interval_mi: null, inspect_interval_mi: 100 });
  });

  it("inspection only (Decision D) clears the replacement schedule but keeps its history", () => {
    const plan = planFrom({ tracks: "inspection", inspectMi: "500", intervalMi: "999" });
    expect(plan.success && plan.data).toMatchObject({ tracks: "inspection", interval_mi: null, inspect_interval_mi: 500 });
    expect(plan.success && "last_done_on" in plan.data).toBe(false);
  });

  it("checks the check schedule only when it is shown", () => {
    const bad = planFrom({ tracks: "inspection", inspectSeasonal: "on", inspectSeasonMonth: "2", inspectSeasonDay: "30" });
    expect(bad.success).toBe(false);
    expect(planFrom({ tracks: "replacement", inspectSeasonal: "on", inspectSeasonMonth: "2", inspectSeasonDay: "30" }).success).toBe(true);
    expect(planFrom({ tracks: "inspection", intervalMi: "-5", inspectMi: "10" }).success).toBe(true);
  });
});
