import { describe, expect, it } from "vitest";

import { equipmentChanges } from "./diff";
import {
  QUICK_TUNE_SECTIONS,
  baseOf,
  invalidNumbers,
  isStepUnit,
  numberDelta,
  parseViewMode,
  pendingChanges,
  sectionRows,
  stepValue,
} from "./quick-tune";
import { SUGGESTED_SETTINGS } from "./template";
import {
  SUSPENSION_ZONES,
  describeEquipment,
  equipmentMismatch,
  type Equipment,
  type Snapshot,
  type SuspensionFeedback,
  type SuspensionRevision,
  type SuspensionSetting,
  type SuspensionZone,
  type TrailCondition,
} from "./types";
import { dislikeWarning, matchingConfigurations, sameValues } from "./warnings";

let n = 0;
const setting = (
  name: string,
  zone: SuspensionZone,
  unit: string | null = "clicks",
  valueType: "number" | "text" = "number",
): SuspensionSetting => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  name,
  zone,
  unit,
  valueType,
  position: n * 10,
  inputMethods: "measurement",
  notes: null,
  version: 1,
  photos: [],
});
const snap = (values: Record<string, string>, settings: SuspensionSetting[]): Snapshot =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => {
      const s = settings.find((x) => x.id === id)!;
      return [id, { value, name: s.name, zone: s.zone, unit: s.unit, type: s.valueType }];
    }),
  );
const feedback = (rating: SuspensionFeedback["rating"], conditions: TrailCondition[] = []): SuspensionFeedback => ({
  id: `f${++n}`,
  revisionId: "r",
  riddenOn: "2026-01-01",
  rating,
  conditions,
  highTempF: null,
  note: null,
  createdBy: null,
  createdByName: "You",
  createdAt: "2026-01-01T00:00:00Z",
  version: 1,
});
const config = (
  configNumber: number,
  values: Snapshot,
  equipment: Equipment,
  extra: Partial<SuspensionRevision> = {},
): SuspensionRevision => ({
  id: `rev-${configNumber}`,
  setupId: "setup",
  number: configNumber,
  configNumber,
  equipment,
  basedOnId: null,
  values,
  display: values,
  turns: {},
  note: null,
  odometer: null,
  engineHours: null,
  restoredFrom: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  createdByName: "You",
  feedback: [],
  photos: [],
  measurementPhotos: [],
  ...extra,
});

describe("Quick Tune sections", () => {
  it("has the five approved sections and covers every zone exactly once", () => {
    expect(QUICK_TUNE_SECTIONS.map((s) => s.label)).toEqual([
      "Front Ski Shocks",
      "Front Track Shock",
      "Rear Track Shock",
      "Springs & Limiter Strap",
      "Rear General",
    ]);
    expect(QUICK_TUNE_SECTIONS.flatMap((s) => s.zones).sort()).toEqual([...SUSPENSION_ZONES].sort());
  });

  it("combines matching left and right ski-shock settings; keeps the rest separate", () => {
    const lc = setting("Compression", "front_left_shock");
    const rc = setting("compression ", "front_right_shock", "Clicks");
    const lr = setting("Rebound", "front_left_shock");
    const rr = setting("Rebound", "front_right_shock", "turns"); // different unit: not paired
    const stance = setting("Ski stance", "front_general", "in");
    const rows = sectionRows([lc, rc, lr, rr, stance], "front-ski-shocks");
    expect(rows.map((r) => (r.kind === "pair" ? `pair:${r.label}` : `${r.side}:${r.label}`))).toEqual([
      "pair:Compression",
      "Left:Rebound",
      "Right:Rebound",
      "Front general:Ski stance",
    ]);
    const strap = setting("Limiter strap", "rear_springs_limiter", "hole");
    expect(sectionRows([strap, lc], "springs-limiter").map((r) => r.key)).toEqual([strap.id]);
    expect(sectionRows([lc], "rear-general")).toEqual([]);
  });

  it("maps existing settings in every old zone into a section", () => {
    const all = SUSPENSION_ZONES.map((z) => setting(`S ${z}`, z));
    const shown = QUICK_TUNE_SECTIONS.flatMap((s) => sectionRows(all, s.id)).flatMap((r) =>
      r.kind === "pair" ? [r.left.id, r.right.id] : [r.setting.id],
    );
    expect(shown.sort()).toEqual(all.map((s) => s.id).sort());
  });

  it("starts from one general template of names and units, no values", () => {
    expect(SUGGESTED_SETTINGS.length).toBeGreaterThan(5);
    expect(SUGGESTED_SETTINGS.every((s) => !("value" in s))).toBe(true);
    const settings = SUGGESTED_SETTINGS.map((t) => setting(t.name, t.zone, t.unit, t.valueType));
    expect(sectionRows(settings, "front-ski-shocks").filter((r) => r.kind === "pair")).toHaveLength(3);
  });
});

describe("Quick Tune values", () => {
  it("steps whole clicks with + and −, keeping decimals", () => {
    expect(stepValue("10", 1)).toBe("11");
    expect(stepValue("0", -1)).toBe("-1");
    expect(stepValue("2.5", -1)).toBe("1.5");
    expect(stepValue("", 1)).toBe("1");
    expect(stepValue("abc", 1)).toBeNull();
    expect(isStepUnit("Clicks")).toBe(true);
    expect(isStepUnit("turns")).toBe(true);
    expect(isStepUnit("hole")).toBe(true);
    expect(isStepUnit("in")).toBe(false);
    expect(isStepUnit("mm")).toBe(false);
    expect(isStepUnit(null)).toBe(false);
  });

  it("shows the difference from the saved value", () => {
    expect(numberDelta("10", "12")).toBe("+2");
    expect(numberDelta("12", "10")).toBe("−2");
    expect(numberDelta("1.5", "1.25")).toBe("−0.25");
    expect(numberDelta("10", "10.0")).toBeNull();
    expect(numberDelta(null, "3")).toBeNull();
  });

  it("collects several pending changes and ignores edits back to the saved value", () => {
    const a = setting("Compression", "front_left_shock");
    const b = setting("Strap", "rear_springs_limiter", "hole");
    const c = setting("Notes", "rear_general", null, "text");
    const saved = snap({ [a.id]: "10", [b.id]: "3", [c.id]: "Stiff" }, [a, b, c]);
    expect(pendingChanges({ [a.id]: "12", [b.id]: "3.0", [c.id]: "" }, saved, [a, b, c])).toEqual({ [a.id]: "12", [c.id]: null });
    expect(pendingChanges({ [a.id]: "10" }, saved, [a, b, c])).toEqual({});
    expect(invalidNumbers({ [a.id]: "ten", [b.id]: "" }, [a, b, c])).toEqual([a.id]);
  });
});

describe("configurations", () => {
  const xpt6: Equipment = { ski: "ca_pro_xpt", carbide: "6" };
  const xcs75: Equipment = { ski: "ca_pro_xcs", carbide: "7.5" };

  it("describes equipment and its changes", () => {
    expect(describeEquipment(xpt6)).toBe('C&A Pro XPT · 6" carbides');
    expect(describeEquipment({ ski: null, carbide: null })).toBe("Not recorded");
    expect(equipmentChanges(xpt6, xcs75)).toEqual(["Skis: XPT → XCS", 'Carbides: 6" → 7.5"']);
    expect(equipmentChanges(xpt6, xpt6)).toEqual([]);
  });

  it("flags equipment that differs from what's installed (not recorded never conflicts)", () => {
    expect(equipmentMismatch(xpt6, xcs75)).toBe(true);
    expect(equipmentMismatch(xpt6, xpt6)).toBe(false);
    expect(equipmentMismatch({ ski: null, carbide: null }, xcs75)).toBe(false);
    expect(equipmentMismatch({ ski: "ca_pro_xcs", carbide: null }, xcs75)).toBe(false);
  });

  it("knows what each configuration was made from", () => {
    const one = config(1, {}, xpt6);
    const two = config(2, {}, xpt6, { number: 2 });
    const three = config(3, {}, xpt6, { number: 3, basedOnId: one.id });
    expect(baseOf([one, two, three], three)?.configNumber).toBe(1);
    expect(baseOf([one, two, three], two)?.configNumber).toBe(1); // older data: the one before it
    expect(baseOf([one, two, three], one)).toBeUndefined();
  });

  it("remembers Quick Tune or the map", () => {
    expect(parseViewMode("map")).toBe("map");
    expect(parseViewMode(undefined)).toBe("quick");
    expect(parseViewMode("other")).toBe("quick");
  });
});

describe("disliked-before warnings", () => {
  const a = setting("Compression", "front_left_shock");
  const values = snap({ [a.id]: "12" }, [a]);
  const xpt6: Equipment = { ski: "ca_pro_xpt", carbide: "6" };

  it("matches on every value and on skis and carbides", () => {
    expect(sameValues(values, snap({ [a.id]: "12.0" }, [a]))).toBe(true);
    expect(sameValues(values, snap({ [a.id]: "13" }, [a]))).toBe(false);
    expect(sameValues(values, {})).toBe(false);
    const list = [config(1, values, xpt6), config(2, values, { ski: "ca_pro_xcs", carbide: "6" }), config(3, {}, xpt6)];
    expect(matchingConfigurations({ values, equipment: xpt6 }, list).map((r) => r.configNumber)).toEqual([1]);
  });

  it("warns with the conditions it was disliked in, and where it was liked", () => {
    const disliked = config(2, values, xpt6, { feedback: [feedback("disliked", ["loose_snow"]), feedback("liked", ["hard_pack"])] });
    const warning = dislikeWarning([disliked])!;
    expect(warning.message).toBe(
      "This suspension configuration was previously rated Disliked under Loose Snow conditions. It was rated Liked under Hard Pack too. Review your earlier feedback before trying it again.",
    );
    expect(warning.configurations).toEqual(["Trail 2"]);
  });

  it("matches the example wording when only disliked", () => {
    const w = dislikeWarning([config(4, values, xpt6, { feedback: [feedback("disliked", ["loose_snow"])] })])!;
    expect(w.message).toBe(
      "This suspension configuration was previously rated Disliked under Loose Snow conditions. Review your earlier feedback before trying it again.",
    );
  });

  it("says when no conditions were recorded, and stays quiet without a Disliked rating", () => {
    expect(dislikeWarning([config(1, values, xpt6, { feedback: [feedback("disliked")] })])!.message).toContain(
      "(no trail conditions were recorded)",
    );
    expect(dislikeWarning([config(1, values, xpt6, { feedback: [feedback("neutral", ["sloppy"]), feedback("worse")] })])).toBeNull();
    expect(dislikeWarning([])).toBeNull();
  });
});
