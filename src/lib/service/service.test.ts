import { describe, expect, it } from "vitest";

import { canFixReading, serviceCapabilities, sledCapabilities } from "@/lib/sleds/permissions";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { fieldErrorsOf } from "@/lib/validation/auth";

import { CATEGORY_VALUES } from "./constants";
import { formatUsd, partLineTotal, serviceCosts } from "./costs";
import { parseAmount, partsPayload, tasksPayload } from "./form";
import { groupBySeason, seasonOf } from "./history";
import { describeBounds, meterRangeOn, type RangeReading } from "./meter-range";
import { createServiceSchema, serviceReading, updateServiceSchema } from "./validation";

const KEY = "0b6c3c1e-1f7e-4f62-9a55-3c7b2f9d1e00";

describe("service costs (match the database view, in cents)", () => {
  it("adds parts, labor and other costs", () => {
    const costs = serviceCosts({
      parts: [
        { quantity: 3, unitCost: 12.5 },
        { quantity: 1, unitCost: 4.25 },
        { quantity: 2, unitCost: null },
      ],
      laborCost: 40,
      otherCost: 5,
    });
    expect(costs).toEqual({ parts: 41.75, labor: 40, other: 5, total: 86.75 });
  });

  it("avoids floating-point drift", () => {
    expect(serviceCosts({ parts: [{ quantity: 3, unitCost: 0.1 }] }).total).toBe(0.3);
    expect(partLineTotal({ quantity: 1.5, unitCost: 19.99 })).toBe(29.99);
    expect(serviceCosts({ parts: [] }).total).toBe(0);
  });

  it("formats US dollars", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("$0.00");
  });
});

describe("date-aware mileage range", () => {
  const readings: RangeReading[] = [
    { id: "a", readOn: "2025-12-05", odometer: 1200, engineHours: 95, odometerReset: false, hourMeterReset: false },
    { id: "b", readOn: "2026-02-01", odometer: 1450, engineHours: null, odometerReset: false, hourMeterReset: false },
    { id: "c", readOn: "2026-11-17", odometer: 2000, engineHours: 150, odometerReset: false, hourMeterReset: false },
  ];

  it("bounds a historical date by the readings around it", () => {
    const range = meterRangeOn(readings, "2026-01-10");
    expect(range.odometer).toEqual({ min: 1200, max: 1450 });
    expect(range.engineHours).toEqual({ min: 95, max: 150 });
    expect(describeBounds(range.odometer, "mi")).toBe("Between 1,200 and 1,450 mi");
  });

  it("has no lower bound before the first reading and no upper bound after the last", () => {
    expect(meterRangeOn(readings, "2025-01-01").odometer).toEqual({ min: null, max: 1200 });
    expect(describeBounds({ min: 2000, max: null }, "mi")).toBe("At least 2,000 mi");
    expect(describeBounds({ min: null, max: null }, "mi")).toBeNull();
  });

  it("counts same-day readings as earlier (the database orders by entry time)", () => {
    expect(meterRangeOn(readings, "2026-02-01").odometer).toEqual({ min: 1450, max: 2000 });
  });

  it("ignores the record's own reading when editing", () => {
    expect(meterRangeOn(readings, "2026-02-01", "b").odometer).toEqual({ min: 1200, max: 2000 });
  });

  it("drops the upper bound when a later reading replaced the meter", () => {
    const replaced = [...readings, { id: "d", readOn: "2026-12-01", odometer: 5, engineHours: null, odometerReset: true, hourMeterReset: false }];
    expect(meterRangeOn(replaced, "2026-11-20").odometer).toEqual({ min: 2000, max: null });
  });
});

describe("service validation", () => {
  const valid = {
    title: " Preseason service ",
    performedOn: "2025-12-05",
    odometer: "1,200",
    engineHours: "",
    category: "drivetrain",
    laborCost: "40",
    tasks: JSON.stringify([{ name: "Change chaincase oil" }, { taskId: KEY, name: "" }]),
    parts: JSON.stringify([{ name: "Oil", quantity: "2", unitCost: "12.50", partNumber: "" }]),
    idempotencyKey: KEY,
  };

  it("accepts a full record and normalizes it", () => {
    const record = createServiceSchema.parse(valid);
    expect(record).toMatchObject({ title: "Preseason service", odometer: 1200, laborCost: 40, mileageUnknown: false });
    expect(record.engineHours).toBeUndefined();
    expect(record.tasks).toHaveLength(2);
    expect(record.parts[0]).toMatchObject({ name: "Oil", quantity: 2, unitCost: 12.5 });
    expect(record.parts[0].partNumber).toBeUndefined();
  });

  it("requires mileage unless it is marked unknown", () => {
    const missing = createServiceSchema.safeParse({ ...valid, odometer: "" });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(fieldErrorsOf(missing.error).odometer?.[0]).toMatch(/Mileage unknown/);
    const unknown = createServiceSchema.parse({ ...valid, odometer: "", mileageUnknown: "on" });
    expect(serviceReading(unknown)).toBeNull();
    expect(serviceReading(createServiceSchema.parse(valid))).toEqual({ odometer_mi: 1200, engine_hours: null });
  });

  it.each([
    ["a blank title", { title: "  " }, "title"],
    ["an unknown category", { category: "paint" }, "category"],
    ["a future date", { performedOn: "2999-01-01" }, "performedOn"],
    ["negative labor", { laborCost: "-1" }, "laborCost"],
    ["a part without a name", { parts: JSON.stringify([{ name: "", quantity: "1" }]) }, "parts"],
    ["a zero quantity", { parts: JSON.stringify([{ name: "Belt", quantity: "0" }]) }, "parts"],
    ["a task without a name", { tasks: JSON.stringify([{ name: " " }]) }, "tasks"],
    ["unreadable item lists", { tasks: "{not json" }, "tasks"],
    ["too many parts", { parts: JSON.stringify(Array.from({ length: 101 }, () => ({ name: "x", quantity: "1" }))) }, "parts"],
  ])("rejects %s", (_label, change, field) => {
    const result = createServiceSchema.safeParse({ ...valid, ...change });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrorsOf(result.error)[field as keyof typeof valid]).toBeDefined();
  });

  it("needs a version to edit and a key to create", () => {
    const rest: Partial<typeof valid> = { ...valid };
    delete rest.idempotencyKey;
    expect(updateServiceSchema.safeParse({ ...rest, version: "3" }).success).toBe(true);
    expect(updateServiceSchema.safeParse(rest).success).toBe(false);
    expect(createServiceSchema.safeParse(rest).success).toBe(false);
  });

  it("knows exactly the database's categories", () => {
    expect(CATEGORY_VALUES).toEqual([
      "engine", "drivetrain", "track_suspension", "fuel_oil", "cooling", "electrical",
      "brakes", "steering_skis", "body_accessories", "inspection", "other",
    ]);
  });
});

describe("form payloads", () => {
  it("leaves out empty rows and keeps ids", () => {
    expect(JSON.parse(tasksPayload([
      { key: "1", id: KEY, name: " Oil " },
      { key: "2", name: "  " },
      { key: "3", taskId: KEY, name: "Belt" },
    ]))).toEqual([{ id: KEY, name: "Oil" }, { taskId: KEY, name: "Belt" }]);
    expect(JSON.parse(partsPayload([
      { key: "1", name: "", partNumber: "", brand: "", supplier: "", quantity: "1", unitCost: "" },
      { key: "2", name: "Belt", partNumber: "B-1", brand: "", supplier: "", quantity: "1", unitCost: "180" },
    ]))).toHaveLength(1);
  });

  it("parses amounts typed in forms", () => {
    expect(parseAmount("$1,234.50")).toBe(1234.5);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
});

describe("service history seasons", () => {
  it("groups by snowmobile season (July to June)", () => {
    expect(seasonOf("2025-12-05")).toBe("2025–26");
    expect(seasonOf("2026-02-01")).toBe("2025–26");
    expect(seasonOf("2026-07-01")).toBe("2026–27");
    const groups = groupBySeason([
      { performedOn: "2026-11-17", costs: { total: 10.1 } },
      { performedOn: "2026-02-01", costs: { total: 20.2 } },
      { performedOn: "2025-12-05", costs: { total: 0.1 } },
    ]);
    expect(groups.map((g) => [g.season, g.records.length, g.total])).toEqual([
      ["2026–27", 1, 10.1],
      ["2025–26", 2, 20.3],
    ]);
  });
});

describe("service permissions", () => {
  it("follows the sharing roles", () => {
    expect(sledCapabilities("mechanic")).toMatchObject({ canLogService: true, canManageSledTasks: false });
    expect(sledCapabilities("viewer")).toMatchObject({ canLogService: false, canManageSledTasks: false });
    expect(sledCapabilities("editor")).toMatchObject({ canLogService: true, canManageSledTasks: true });
  });

  it("lets mechanics edit only their own records, and never delete or remove mileage", () => {
    expect(serviceCapabilities("mechanic", "me", "me")).toEqual({ canEdit: true, canDelete: false, canRemoveMileage: false });
    expect(serviceCapabilities("mechanic", "owner", "me").canEdit).toBe(false);
    expect(serviceCapabilities("editor", "someone", "me")).toEqual({ canEdit: true, canDelete: true, canRemoveMileage: true });
    expect(serviceCapabilities("viewer", "me", "me").canEdit).toBe(false);
    expect(canFixReading("mechanic", "me", "me")).toBe(true);
  });

  it("explains service errors", () => {
    expect(sledErrorMessage({ code: "PT409" }, "service record")).toMatch(/This service record was changed/);
    expect(sledErrorMessage({ code: "23505" })).toBe("You already have one with that name.");
    const message = "Only the owner or an editor can remove the mileage from a service record.";
    expect(sledErrorMessage({ code: "42501", message })).toBe(message);
  });
});
