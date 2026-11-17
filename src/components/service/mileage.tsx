"use client";

import { useState } from "react";

import { CheckboxField, Field } from "@/components/ui/field";
import { describeBounds, meterRangeOn, type RangeReading } from "@/lib/service/meter-range";

/**
 * Date, mileage and engine hours for a service, with date-aware prefill:
 * for today's date the current odometer and hours are filled in; for a past
 * date they are left empty and the valid range from the surrounding readings
 * is shown instead (the database checks it again on save).
 */
export function useServiceMeters(options: {
  today: string;
  initialDate?: string;
  initialOdometer?: number | null;
  initialHours?: number | null;
  initialUnknown?: boolean;
  current: { odometer: number | null; engineHours: number | null };
  prefillToday: boolean;
}) {
  const [date, setDate] = useState(options.initialDate ?? "");
  const [odometer, setOdometer] = useState<string | null>(
    options.initialOdometer == null ? null : String(options.initialOdometer),
  );
  const [hours, setHours] = useState<string | null>(options.initialHours == null ? null : String(options.initialHours));
  const [unknown, setUnknown] = useState(Boolean(options.initialUnknown));

  const effectiveDate = date || options.today;
  const isToday = Boolean(options.today) && effectiveDate === options.today;
  const prefill = options.prefillToday && isToday;
  return {
    date: effectiveDate,
    setDate,
    // null = not typed yet: show the prefill for today, empty otherwise.
    odometer: odometer ?? (prefill && options.current.odometer != null ? String(options.current.odometer) : ""),
    setOdometer,
    hours: hours ?? (prefill && options.current.engineHours != null ? String(options.current.engineHours) : ""),
    setHours,
    unknown,
    setUnknown,
    isToday,
  };
}

export type ServiceMeters = ReturnType<typeof useServiceMeters>;

export function ServiceMeterFields({
  meters,
  readings,
  excludeReadingId,
  errors,
  today,
  unknownDisabledReason,
}: {
  meters: ServiceMeters;
  readings: RangeReading[];
  excludeReadingId?: string | null;
  errors: Partial<Record<string, string[]>>;
  today: string;
  unknownDisabledReason?: string;
}) {
  const range = meterRangeOn(readings, meters.date, excludeReadingId);
  const pastDate = !meters.isToday;
  const mileageHint = pastDate ? (describeBounds(range.odometer, "mi") ?? "Mileage on the service date.") : undefined;
  const hoursHint = pastDate ? (describeBounds(range.engineHours, "hrs") ?? undefined) : undefined;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Date"
          name="performedOn"
          type="date"
          required
          max={today || undefined}
          value={meters.date}
          onChange={(event) => meters.setDate(event.target.value)}
          error={errors.performedOn?.[0]}
        />
        <Field
          label="Mileage (odometer)"
          name="odometer"
          inputMode="decimal"
          disabled={meters.unknown}
          value={meters.unknown ? "" : meters.odometer}
          onChange={(event) => meters.setOdometer(event.target.value)}
          hint={mileageHint}
          error={errors.odometer?.[0]}
        />
        <Field
          label="Engine hours (optional)"
          name="engineHours"
          inputMode="decimal"
          disabled={meters.unknown}
          value={meters.unknown ? "" : meters.hours}
          onChange={(event) => meters.setHours(event.target.value)}
          hint={hoursHint}
          error={errors.engineHours?.[0]}
        />
      </div>
      <CheckboxField
        label="Mileage unknown"
        name="mileageUnknown"
        checked={meters.unknown}
        disabled={Boolean(unknownDisabledReason)}
        onChange={(event) => meters.setUnknown(event.target.checked)}
        hint={unknownDisabledReason ?? "For older records where the odometer wasn't noted."}
      />
    </div>
  );
}
