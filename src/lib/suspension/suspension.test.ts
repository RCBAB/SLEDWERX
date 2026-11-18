import { describe, expect, it } from "vitest";

import { canEditSuspensionFeedback, suspensionCapabilities } from "@/lib/sleds/permissions";

import { changedValues, compareSnapshots, describeChange, formatValue, latestFeedback, revisionChanges, valuesPerZone } from "./diff";
import { suspensionErrorMessage } from "./errors";
import {
  SUSPENSION_ZONES,
  UNIT_SUGGESTIONS,
  ZONE_GROUPS,
  daysLeftToRestore,
  isRestorable,
  latestRevision,
  sortSettings,
  type Snapshot,
  type SuspensionRevision,
} from "./types";
import { checkSettingValue, normalizeNumber, settingSchema, setupSchema } from "./validation";

const COMP = "11111111-1111-4111-8111-111111111111";
const REB = "22222222-2222-4222-8222-222222222222";
const SPRING = "33333333-3333-4333-8333-333333333333";

const snap = (entries: Record<string, [string, string, string | null, "number" | "text", (typeof SUSPENSION_ZONES)[number]?]>): Snapshot =>
  Object.fromEntries(
    Object.entries(entries).map(([id, [value, name, unit, type, zone]]) => [id, { value, name, unit, type, zone: zone ?? "front_left_shock" }]),
  );

describe("zones", () => {
  it("has the seven approved zones, front then rear", () => {
    expect(SUSPENSION_ZONES).toHaveLength(7);
    expect(ZONE_GROUPS.map((g) => g.zones.length)).toEqual([3, 4]);
    expect(ZONE_GROUPS.flatMap((g) => g.zones)).toEqual([...SUSPENSION_ZONES]);
  });

  it("only suggests units (no settings, no values)", () => {
    expect([...UNIT_SUGGESTIONS]).toEqual(["Clicks", "Turns", "mm", "in", "PSI"]);
  });

  it("sorts settings by zone, position, then name", () => {
    const sorted = sortSettings<{ name: string; zone: (typeof SUSPENSION_ZONES)[number]; position: number }>([
      { name: "B", zone: "rear_general", position: 0 },
      { name: "Rebound", zone: "front_left_shock", position: 10 },
      { name: "Compression", zone: "front_left_shock", position: 10 },
      { name: "Preload", zone: "front_left_shock", position: 0 },
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["Preload", "Compression", "Rebound", "B"]);
  });
});

describe("number values", () => {
  it.each([
    ["12", "12"],
    [" 12 ", "12"],
    ["+2", "2"],
    [".5", "0.5"],
    ["-.5", "-0.5"],
    ["5.", "5"],
    ["−3", "-3"],
    ["1 000", "1000"],
    ["007", "7"],
    ["-0", "0"],
    ["2.25", "2.25"],
  ])("normalizes %j to %j", (input, output) => {
    expect(normalizeNumber(input)).toBe(output);
  });

  it.each(["soft", "1/2", "1e3", "--1", "1.2.3", "12 clicks", "", "."])("rejects %j", (input) => {
    expect(normalizeNumber(input)).toBeNull();
  });

  it("matches the database rule", () => {
    for (const ok of ["0", "-3", "10.5"]) expect(/^-?[0-9]+(\.[0-9]+)?$/.test(normalizeNumber(ok)!)).toBe(true);
  });

  it("checks values by setting type; blank means no value", () => {
    expect(checkSettingValue("number", "", "Rebound")).toEqual({ ok: true, value: null });
    expect(checkSettingValue("number", " 8 ", "Rebound")).toEqual({ ok: true, value: "8" });
    expect(checkSettingValue("number", "soft", "Rebound")).toEqual({ ok: false, error: "Enter a number for Rebound." });
    expect(checkSettingValue("text", " Stiff spring ", "Spring")).toEqual({ ok: true, value: "Stiff spring" });
    expect(checkSettingValue("text", "x".repeat(201), "Spring").ok).toBe(false);
  });
});

describe("forms", () => {
  it("requires a name and a known zone for settings; unit is free text", () => {
    expect(settingSchema.safeParse({ name: "", zone: "front_left_shock", valueType: "number" }).success).toBe(false);
    expect(settingSchema.safeParse({ name: "Rebound", zone: "middle", valueType: "number" }).success).toBe(false);
    const ok = settingSchema.safeParse({ name: " Rebound ", zone: "front_left_shock", valueType: "number", unit: "clicks out", notes: "" });
    expect(ok.success && ok.data).toEqual({ name: "Rebound", zone: "front_left_shock", valueType: "number", unit: "clicks out", notes: undefined });
    expect(settingSchema.safeParse({ name: "X", zone: "rear_general", valueType: "number", unit: "x".repeat(21) }).success).toBe(false);
  });

  it("limits setup names to 80 characters", () => {
    expect(setupSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(setupSchema.safeParse({ name: "Deep powder" }).success).toBe(true);
  });
});

describe("changes between revisions", () => {
  const r1 = snap({ [COMP]: ["12", "Compression", "clicks", "number"], [REB]: ["8", "Rebound", "clicks", "number"] });
  const r2 = snap({
    [COMP]: ["12", "Compression", "clicks", "number"],
    [REB]: ["10", "Rebound", "clicks", "number"],
    [SPRING]: ["Stiff", "Spring", null, "text", "rear_springs_limiter"],
  });

  it("lists changed, added and cleared settings, not unchanged ones", () => {
    const changes = revisionChanges(r1, r2);
    expect(changes.map((c) => [c.name, c.kind, c.before, c.after])).toEqual([
      ["Rebound", "changed", "8", "10"],
      ["Spring", "added", null, "Stiff"],
    ]);
    expect(revisionChanges(r2, r1).map((c) => c.kind)).toEqual(["changed", "cleared"]);
    expect(revisionChanges(r1, r1)).toEqual([]);
  });

  it("treats the first revision as all added", () => {
    expect(revisionChanges(null, r1).every((c) => c.kind === "added")).toBe(true);
  });

  it("describes changes in plain words", () => {
    const [rebound, spring] = revisionChanges(r1, r2);
    expect(describeChange(rebound)).toBe("Rebound: 8 → 10 clicks");
    expect(describeChange(spring)).toBe("Spring: set to Stiff");
    expect(describeChange(revisionChanges(r2, r1)[1])).toBe("Spring: cleared (was Stiff)");
  });

  it("formats values with units (text values have none)", () => {
    expect(formatValue("10", "clicks")).toBe("10 clicks");
    expect(formatValue("Stiff", "clicks", "text")).toBe("Stiff");
    expect(formatValue(null, "clicks")).toBe("—");
  });

  it("sends only the values that changed; blank clears", () => {
    expect(changedValues(r1, { [COMP]: "12", [REB]: "10" })).toEqual({ [REB]: "10" });
    expect(changedValues(r1, { [COMP]: "", [SPRING]: null })).toEqual({ [COMP]: null });
    expect(changedValues(r1, {})).toEqual({});
  });

  it("compares any two revisions, marking what differs", () => {
    const rows = compareSnapshots(r1, r2);
    expect(rows.map((r) => [r.name, r.a, r.b, r.changed])).toEqual([
      ["Compression", "12", "12", false],
      ["Rebound", "8", "10", true],
      ["Spring", null, "Stiff", true],
    ]);
  });

  it("follows the current settings order within a zone", () => {
    const rows = compareSnapshots(r1, r1, [
      { id: REB, position: 0 },
      { id: COMP, position: 10 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Rebound", "Compression"]);
  });

  it("counts values per zone", () => {
    expect(valuesPerZone(r2)).toMatchObject({ front_left_shock: 2, rear_springs_limiter: 1, rear_general: 0 });
  });
});

describe("history helpers", () => {
  it("finds the latest revision of a setup", () => {
    const rev = (setupId: string, number: number) => ({ id: `${setupId}-${number}`, setupId, number }) as SuspensionRevision;
    expect(latestRevision([rev("a", 1), rev("a", 3), rev("b", 9), rev("a", 2)], "a")?.number).toBe(3);
    expect(latestRevision([], "a")).toBeUndefined();
  });

  it("picks the newest feedback by ride date", () => {
    const newest = latestFeedback([
      { riddenOn: "2026-11-10", createdAt: "2026-11-10T10:00:00Z", rating: "worse" },
      { riddenOn: "2026-11-12", createdAt: "2026-11-12T08:00:00Z", rating: "improved" },
      { riddenOn: "2026-11-12", createdAt: "2026-11-12T09:00:00Z", rating: "no_change" },
    ]);
    expect(newest?.rating).toBe("no_change");
  });

  it("allows restores for 30 days", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(isRestorable("2026-11-01T12:00:00Z", now)).toBe(true);
    expect(isRestorable("2026-10-18T11:00:00Z", now)).toBe(false);
    expect(daysLeftToRestore("2026-11-17T12:00:00Z", now)).toBe(29);
    expect(daysLeftToRestore("2026-10-01T12:00:00Z", now)).toBe(0);
  });
});

describe("permissions", () => {
  it("owners and editors manage; mechanics adjust; viewers read", () => {
    expect(suspensionCapabilities("owner")).toEqual({
      canManage: true,
      canAdjust: true,
      canAddFeedback: true,
      canAddReferencePhotos: true,
      canAddAdjustmentPhotos: true,
      canRemove: true,
    });
    expect(suspensionCapabilities("editor").canManage).toBe(true);
    expect(suspensionCapabilities("mechanic")).toEqual({
      canManage: false,
      canAdjust: true,
      canAddFeedback: true,
      canAddReferencePhotos: false,
      canAddAdjustmentPhotos: true,
      canRemove: false,
    });
    expect(Object.values(suspensionCapabilities("viewer")).every((v) => v === false)).toBe(true);
  });

  it("mechanics edit only their own feedback", () => {
    expect(canEditSuspensionFeedback("mechanic", "me", "me")).toBe(true);
    expect(canEditSuspensionFeedback("mechanic", "other", "me")).toBe(false);
    expect(canEditSuspensionFeedback("editor", "other", "me")).toBe(true);
    expect(canEditSuspensionFeedback("viewer", "me", "me")).toBe(false);
  });
});

describe("error messages", () => {
  it("shows the database's own messages and friendly ones for codes", () => {
    expect(suspensionErrorMessage({ code: "23514", message: "Make another setup active before deleting this one." }, "setup")).toBe(
      "Make another setup active before deleting this one.",
    );
    expect(suspensionErrorMessage({ code: "PT409", message: "This setup was changed by someone else. Reload it and try again." }, "setup")).toBe(
      "This setup was changed by someone else. Reload it and try again.",
    );
    expect(suspensionErrorMessage({ code: "23505", message: "duplicate key value violates unique constraint" }, "setting")).toMatch(/already a setting/);
    expect(suspensionErrorMessage({ code: "PT409", message: "Row was updated" }, "setting")).toMatch(/changed somewhere else/);
    expect(suspensionErrorMessage({ code: "XX000", message: "internal SQL detail" }, "setup")).toBe("Something went wrong. Please try again.");
  });
});
