/**
 * Update Mileage / Hours: works out what a reading update actually changes,
 * and refuses a normal update that would make a meter go down.
 *
 * This only gives clear, field-level messages before saving. The database
 * (Migration 2's reading-order trigger) is the rule that always applies: it
 * refuses any reading that goes down within a meter's history, for every
 * caller, and allows a lower value only on a reading marked as a reset.
 */

export type CurrentMeter = { value: number; readOn: string } | null;
export type CurrentMeters = { odometer: CurrentMeter; engineHours: CurrentMeter };

export type MeterUpdateInput = {
  odometer?: number;
  engineHours?: number;
  readOn: string;
  odometerReset: boolean;
  hourMeterReset: boolean;
  /** "Yes, the meter was replaced or reset" — required with either reset. */
  confirmReset: boolean;
};

export type MeterUpdatePlan =
  | { ok: true; odometer: number | null; engineHours: number | null; odometerReset: boolean; hourMeterReset: boolean }
  | { ok: false; fieldErrors: Partial<Record<"odometer" | "engineHours" | "confirmReset", string[]>> };

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * - A value equal to the current reading is "unchanged" and not saved again,
 *   so updating only the hours never repeats the mileage (unless it's a reset).
 * - Nothing changed: nothing to save.
 * - A normal update dated on or after the current reading can't be lower.
 *   (Older, backdated readings are checked against the history by the
 *   database, which knows the readings around that date.)
 * - A reset needs explicit confirmation.
 */
export function planMeterUpdate(input: MeterUpdateInput, current: CurrentMeters): MeterUpdatePlan {
  const errors: Partial<Record<"odometer" | "engineHours" | "confirmReset", string[]>> = {};

  const pick = (value: number | undefined, meter: CurrentMeter, reset: boolean) => {
    if (value === undefined) return null;
    if (!reset && meter && value === meter.value) return null;
    return value;
  };
  const odometer = pick(input.odometer, current.odometer, input.odometerReset);
  const engineHours = pick(input.engineHours, current.engineHours, input.hourMeterReset);

  if ((input.odometerReset || input.hourMeterReset) && !input.confirmReset) {
    errors.confirmReset = ["Confirm that the meter was replaced or reset."];
  }
  if (odometer != null && !input.odometerReset && current.odometer && input.readOn >= current.odometer.readOn && odometer < current.odometer.value) {
    errors.odometer = [
      `Mileage can't be lower than the current ${number.format(current.odometer.value)} mi. If the odometer was replaced or reset, use More options.`,
    ];
  }
  if (
    engineHours != null &&
    !input.hourMeterReset &&
    current.engineHours &&
    input.readOn >= current.engineHours.readOn &&
    engineHours < current.engineHours.value
  ) {
    errors.engineHours = [
      `Engine hours can't be lower than the current ${number.format(current.engineHours.value)} hrs. If the hour meter was replaced or reset, use More options.`,
    ];
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  if (odometer == null && engineHours == null) {
    return { ok: false, fieldErrors: { odometer: ["Nothing changed. Enter a new mileage, new engine hours, or both."] } };
  }
  return {
    ok: true,
    odometer,
    engineHours,
    odometerReset: input.odometerReset && odometer != null,
    hourMeterReset: input.hourMeterReset && engineHours != null,
  };
}
