import { describe, expect, it } from "vitest";

import { planMeterUpdate, type CurrentMeters, type MeterUpdateInput } from "./meters";

const current: CurrentMeters = {
  odometer: { value: 2000, readOn: "2026-11-10" },
  engineHours: { value: 150, readOn: "2026-11-10" },
};
const input = (change: Partial<MeterUpdateInput>): MeterUpdateInput => ({
  readOn: "2026-11-18",
  odometerReset: false,
  hourMeterReset: false,
  confirmReset: false,
  ...change,
});

describe("Update Mileage / Hours", () => {
  it("saves only what changed", () => {
    expect(planMeterUpdate(input({ odometer: 2100, engineHours: 150 }), current)).toEqual({
      ok: true,
      odometer: 2100,
      engineHours: null,
      odometerReset: false,
      hourMeterReset: false,
    });
    expect(planMeterUpdate(input({ odometer: 2000, engineHours: 160 }), current)).toMatchObject({
      ok: true,
      odometer: null,
      engineHours: 160,
    });
    expect(planMeterUpdate(input({ odometer: 2100, engineHours: 160 }), current)).toMatchObject({ odometer: 2100, engineHours: 160 });
    expect(planMeterUpdate(input({ odometer: 2100 }), current)).toMatchObject({ odometer: 2100, engineHours: null });
  });

  it("says when nothing changed", () => {
    expect(planMeterUpdate(input({ odometer: 2000, engineHours: 150 }), current)).toEqual({
      ok: false,
      fieldErrors: { odometer: ["Nothing changed. Enter a new mileage, new engine hours, or both."] },
    });
  });

  it("refuses lower readings, each meter on its own", () => {
    const low = planMeterUpdate(input({ odometer: 1999, engineHours: 150 }), current);
    expect(low).toEqual({
      ok: false,
      fieldErrors: {
        odometer: ["Mileage can't be lower than the current 2,000 mi. If the odometer was replaced or reset, use More options."],
      },
    });
    const lowHours = planMeterUpdate(input({ odometer: 2100, engineHours: 149.5 }), current);
    expect(lowHours).toMatchObject({ ok: false, fieldErrors: { engineHours: [expect.stringContaining("150 hrs")] } });
  });

  it("accepts any first reading for a meter that was never recorded", () => {
    expect(planMeterUpdate(input({ engineHours: 3 }), { ...current, engineHours: null })).toMatchObject({ ok: true, engineHours: 3 });
  });

  it("leaves older, backdated readings to the database's history check", () => {
    expect(planMeterUpdate(input({ odometer: 1500, readOn: "2026-10-01" }), current)).toMatchObject({ ok: true, odometer: 1500 });
  });

  it("allows a lower reading only as a confirmed reset", () => {
    expect(planMeterUpdate(input({ odometer: 5, odometerReset: true }), current)).toEqual({
      ok: false,
      fieldErrors: { confirmReset: ["Confirm that the meter was replaced or reset."] },
    });
    expect(planMeterUpdate(input({ odometer: 5, odometerReset: true, confirmReset: true }), current)).toEqual({
      ok: true,
      odometer: 5,
      engineHours: null,
      odometerReset: true,
      hourMeterReset: false,
    });
    // A reset is saved even when the new meter happens to show the same number.
    expect(planMeterUpdate(input({ engineHours: 150, hourMeterReset: true, confirmReset: true }), current)).toMatchObject({
      ok: true,
      engineHours: 150,
      hourMeterReset: true,
    });
    // The odometer reset doesn't excuse lower hours.
    expect(planMeterUpdate(input({ odometer: 5, engineHours: 100, odometerReset: true, confirmReset: true }), current)).toMatchObject({
      ok: false,
      fieldErrors: { engineHours: [expect.any(String)] },
    });
  });
});
