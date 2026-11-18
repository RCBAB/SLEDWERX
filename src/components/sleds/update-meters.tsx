"use client";

import { Gauge } from "lucide-react";
import { useActionState, useLayoutEffect, useState } from "react";

import { updateMeters, type SledActionState } from "@/app/garage/actions";
import { Sheet } from "@/components/board/sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CheckboxField, Field } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";

type Meter = { value: number; readOn: string } | null;
export type CurrentReadings = { odometer: Meter; engineHours: Meter };

/**
 * "Update Mileage / Hours": a button and a small dialog, used on the sled
 * page and on the Garage Board (Cards, Compact and Wall Display). It saves an
 * ordinary new reading through updateMeters; earlier readings are kept.
 */
export function UpdateMetersButton({
  sledId,
  sledName,
  current,
  size = "lg",
  className,
}: {
  sledId: string;
  sledName: string;
  current: CurrentReadings;
  size?: "md" | "lg";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  // Close when the page is hidden (Next.js keeps it mounted), so it isn't open on return.
  useLayoutEffect(() => () => setOpen(false), []);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size={size}
        className={className}
        aria-label={`Update mileage / hours for ${sledName}`}
        onClick={() => {
          setSession((n) => n + 1);
          setOpen(true);
        }}
      >
        <Gauge aria-hidden className="size-4" />
        Update mileage / hours
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Update mileage / hours" description={sledName}>
        {open ? <UpdateMetersForm key={session} sledId={sledId} current={current} onDone={() => setOpen(false)} /> : null}
      </Sheet>
    </>
  );
}

function currentLine(meter: Meter, format: (v: number) => string) {
  return meter ? `Current: ${format(meter.value)} (${formatDate(meter.readOn)})` : "Not recorded yet";
}

export function UpdateMetersForm({ sledId, current, onDone }: { sledId: string; current: CurrentReadings; onDone: () => void }) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const [state, action] = useActionState<SledActionState, FormData>(async (prev, formData) => {
    const result = await updateMeters(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const [odometerReset, setOdometerReset] = useState(v ? v.odometerReset === "on" : false);
  const [hourMeterReset, setHourMeterReset] = useState(v ? v.hourMeterReset === "on" : false);
  const resetting = odometerReset || hourMeterReset;
  const moreOpen = resetting || Boolean(errors.readOn || errors.confirmReset || (v?.readOn && v.readOn !== today));

  return (
    <form action={action} className="space-y-5" noValidate key={v ? JSON.stringify(v) : "form"}>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Odometer (miles)"
          name="odometer"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v ? (v.odometer ?? "") : current.odometer ? String(current.odometer.value) : ""}
          hint={currentLine(current.odometer, formatMiles)}
          error={errors.odometer?.[0]}
        />
        <Field
          label="Engine hours"
          name="engineHours"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v ? (v.engineHours ?? "") : current.engineHours ? String(current.engineHours.value) : ""}
          hint={currentLine(current.engineHours, formatHours)}
          error={errors.engineHours?.[0]}
        />
      </div>
      <p className="text-sm text-muted">Change either one, or both. Earlier readings are kept in the history.</p>
      <details className="rounded-xl border border-white/10 p-3 text-sm" open={moreOpen}>
        <summary className="cursor-pointer font-medium">More options</summary>
        <div className="mt-3 space-y-4">
          <Field
            // Re-mount once the local date is known so the default is the user's own "today".
            key={today}
            label="Date"
            name="readOn"
            type="date"
            required
            max={today || undefined}
            defaultValue={v?.readOn || today}
            error={errors.readOn?.[0]}
          />
          <fieldset className="space-y-3">
            <legend className="mb-1 font-medium text-foreground/90">Meter replaced or reset?</legend>
            <CheckboxField
              label="The odometer was replaced or reset"
              name="odometerReset"
              checked={odometerReset}
              onChange={(event) => setOdometerReset(event.target.checked)}
              hint="Enter what the new odometer shows. Lifetime miles carry on from the old one."
            />
            <CheckboxField
              label="The hour meter was replaced or reset"
              name="hourMeterReset"
              checked={hourMeterReset}
              onChange={(event) => setHourMeterReset(event.target.checked)}
              hint="Enter what the new hour meter shows. Lifetime hours carry on from the old one."
            />
          </fieldset>
          {resetting ? (
            <div className={cn("rounded-lg border p-3", errors.confirmReset ? "border-accent" : "border-amber-400/40 bg-amber-400/5")}>
              <CheckboxField
                label="Yes, the meter was replaced or reset"
                name="confirmReset"
                defaultChecked={v?.confirmReset === "on"}
                hint="Only then can the new reading be lower than the current one. Earlier readings and maintenance history are kept."
              />
              {errors.confirmReset ? <p className="ml-8 mt-1 text-sm text-accent-hot">{errors.confirmReset[0]}</p> : null}
            </div>
          ) : null}
        </div>
      </details>
      <FormActions>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </FormActions>
    </form>
  );
}
