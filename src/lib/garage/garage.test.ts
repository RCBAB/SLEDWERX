import { describe, expect, it } from "vitest";

import { lastDoneShort, nextDueLine, nextDueShort } from "@/lib/board/describe";
import type { BoardRow, BoardStatus } from "@/lib/board/types";

import { DEFAULT_LAYOUT, isGarageLayout, keyboardFromGarageMode, layoutFromGarageMode, withKeyboard, withLayout } from "./layout";
import { sledSummary } from "./summary";

const base: BoardRow = {
  planId: "p",
  taskId: "t",
  taskName: "Oil",
  intervalMi: 1000,
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
  remainingMi: 200,
  remainingHours: null,
  remainingDays: null,
  status: "good",
};
const row = (change: Partial<BoardRow>): BoardRow => ({ ...base, ...change });
const rows = (...statuses: BoardStatus[]) => statuses.map((status, i) => row({ planId: `p${i}`, status }));

describe("layout preference", () => {
  it("defaults to Full Cards for new users and unknown values", () => {
    expect(DEFAULT_LAYOUT).toBe("cards");
    expect(layoutFromGarageMode({})).toBe("cards");
    expect(layoutFromGarageMode(null)).toBe("cards");
    expect(layoutFromGarageMode({ layout: "huge" })).toBe("cards");
    expect(layoutFromGarageMode([])).toBe("cards");
    expect(layoutFromGarageMode({ layout: "compact" })).toBe("compact");
  });

  it("keeps other Garage Mode settings when saving the layout", () => {
    expect(withLayout({ layout: "cards", other: 1 }, "compact")).toEqual({ layout: "compact", other: 1 });
    expect(withLayout(null, "compact")).toEqual({ layout: "compact" });
    expect(withLayout("junk", "cards")).toEqual({ layout: "cards" });
  });

  it("accepts only known layouts", () => {
    expect(isGarageLayout("cards")).toBe(true);
    expect(isGarageLayout("compact")).toBe(true);
    expect(isGarageLayout("wall")).toBe(false);
    expect(isGarageLayout(undefined)).toBe(false);
  });
});

describe("overall sled status", () => {
  it("is red when anything is overdue", () => {
    const s = sledSummary(rows("good", "overdue", "upcoming", "overdue"));
    expect(s.tone).toBe("red");
    expect(s.label).toBe("Overdue");
    expect(s.detail).toBe("2 overdue · 1 due soon");
  });

  it("is yellow for due soon, no record yet, or unknown mileage", () => {
    expect(sledSummary(rows("good", "upcoming")).label).toBe("Due soon");
    expect(sledSummary(rows("no_record")).label).toBe("No record yet");
    expect(sledSummary(rows("mileage_unknown", "good"))).toMatchObject({ tone: "yellow", label: "Mileage unknown" });
    expect(sledSummary(rows("upcoming", "no_record", "mileage_unknown")).detail).toBe(
      "1 due soon · 1 no record yet · 1 mileage unknown",
    );
  });

  it("is green when every scheduled task is good; paused and unscheduled don't count", () => {
    expect(sledSummary(rows("good", "good", "paused", "unscheduled"))).toMatchObject({
      tone: "green",
      label: "Up to date",
      detail: "All 2 up to date",
    });
    expect(sledSummary(rows("good")).detail).toBe("1 task up to date");
  });

  it("is grey when nothing is tracked", () => {
    expect(sledSummary([])).toMatchObject({ tone: "neutral", label: "Nothing tracked", detail: "No maintenance on the board yet" });
    expect(sledSummary(rows("paused", "unscheduled")).detail).toBe("2 tasks not scheduled");
  });
});

describe("next due", () => {
  const current = { odometer: 2000, engineHours: 150 };

  it("shows the date and the odometer and hour-meter values it's due at", () => {
    expect(nextDueLine(row({ remainingMi: 200, dueOn: "2027-06-05" }), current)).toBe("Next due Jun 5, 2027 · 2,200 mi");
    expect(nextDueLine(row({ remainingMi: -100, remainingHours: 10, status: "overdue" }), current)).toBe(
      "Next due 1,900 mi · 160 hrs",
    );
  });

  it("never estimates mileage", () => {
    expect(nextDueLine(row({ remainingMi: 200 }), { odometer: null, engineHours: null })).toBe("Next due: not set");
    expect(nextDueLine(row({ remainingMi: null, status: "mileage_unknown" }), current)).toBe("Next due: mileage unknown");
    expect(nextDueLine(row({ remainingMi: null, status: "no_record" }), current)).toBe("Next due: starts once it's first done");
  });

  it("says when a task isn't scheduled or is paused", () => {
    expect(nextDueLine(row({ status: "unscheduled" }), current)).toBe("Not scheduled");
    expect(nextDueLine(row({ status: "paused" }), current)).toBe("Paused");
  });
});

describe("compact wording", () => {
  it("drops the prefixes but keeps the facts", () => {
    expect(lastDoneShort(row({}))).toBe("Dec 5, 2025 · 1,200 mi");
    expect(lastDoneShort(row({ lastDoneSource: null }))).toBe("Never");
    expect(lastDoneShort(row({ lastDoneSource: "baseline" }))).toBe("Before SledWerx: Dec 5, 2025 · 1,200 mi");
    expect(lastDoneShort(row({ lastDoneMi: null }))).toBe("Dec 5, 2025 · mileage unknown");
    expect(nextDueShort(row({ remainingMi: 200 }), { odometer: 2000, engineHours: null })).toBe("2,200 mi");
    expect(nextDueShort(row({ status: "no_record", remainingMi: null }), { odometer: 2000, engineHours: null })).toBe(
      "Starts once it's first done",
    );
  });
});

describe("wall keyboard preference", () => {
  it("is on for new users and keeps other settings when saved", () => {
    expect(keyboardFromGarageMode({})).toBe(true);
    expect(keyboardFromGarageMode(null)).toBe(true);
    expect(keyboardFromGarageMode({ keyboard: "no" })).toBe(true);
    expect(keyboardFromGarageMode({ keyboard: false })).toBe(false);
    expect(withKeyboard({ layout: "compact" }, false)).toEqual({ layout: "compact", keyboard: false });
  });
});
