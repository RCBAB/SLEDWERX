export type RangeReading = {
  id: string;
  readOn: string;
  odometer: number | null;
  engineHours: number | null;
  odometerReset: boolean;
  hourMeterReset: boolean;
};

export type MeterBounds = { min: number | null; max: number | null };

/**
 * The values a meter could show on a given date, from the readings around
 * it (the same order the database checks: by date, then entry time). A new
 * reading on that date is entered after any existing reading of the same
 * day, so same-day readings count as "before". A meter replacement after the
 * date removes the upper bound, since the new meter starts a new count.
 * Readings must be sorted oldest first.
 */
function bounds(readings: RangeReading[], date: string, value: (r: RangeReading) => number | null, isReset: (r: RangeReading) => boolean): MeterBounds {
  let min: number | null = null;
  let max: number | null = null;
  for (const reading of readings) {
    const v = value(reading);
    if (v == null) continue;
    if (reading.readOn <= date) {
      min = v;
    } else {
      max = isReset(reading) ? null : v;
      break;
    }
  }
  return { min, max };
}

export function meterRangeOn(readings: RangeReading[], date: string, excludeReadingId?: string | null) {
  const relevant = readings
    .filter((r) => r.id !== excludeReadingId)
    .sort((a, b) => (a.readOn < b.readOn ? -1 : a.readOn > b.readOn ? 1 : 0));
  return {
    odometer: bounds(relevant, date, (r) => r.odometer, (r) => r.odometerReset),
    engineHours: bounds(relevant, date, (r) => r.engineHours, (r) => r.hourMeterReset),
  };
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "Between 1,200 and 2,000 mi", "At least 1,200 mi", or null. */
export function describeBounds(b: MeterBounds, unit: string): string | null {
  if (b.min != null && b.max != null) return `Between ${number.format(b.min)} and ${number.format(b.max)} ${unit}`;
  if (b.min != null) return `At least ${number.format(b.min)} ${unit}`;
  if (b.max != null) return `At most ${number.format(b.max)} ${unit}`;
  return null;
}
