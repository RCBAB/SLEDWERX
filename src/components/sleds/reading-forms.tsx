"use client";

import { useActionState } from "react";

import { addReading, fixLastReading, type SledActionState } from "@/app/garage/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate } from "@/lib/sleds/format";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";

type LastReading = {
  id: string;
  readOn: string;
  odometer: number | null;
  engineHours: number | null;
  odometerReset: boolean;
  hourMeterReset: boolean;
  version: number;
};

function MeterFields({
  state,
  defaults,
}: {
  state: SledActionState;
  defaults?: Partial<Record<"odometer" | "engineHours" | "readOn", string>> & {
    odometerReset?: boolean;
    hourMeterReset?: boolean;
  };
}) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const errors = state.fieldErrors ?? {};
  const value = (key: "odometer" | "engineHours" | "readOn") => state.values?.[key] ?? defaults?.[key] ?? "";
  const checked = (key: "odometerReset" | "hourMeterReset") =>
    state.values ? state.values[key] === "on" : Boolean(defaults?.[key]);

  return (
    <>
      <input type="hidden" name="timeZone" value={timeZone} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Odometer (miles)"
          name="odometer"
          inputMode="decimal"
          defaultValue={value("odometer")}
          error={errors.odometer?.[0]}
        />
        <Field
          label="Engine hours"
          name="engineHours"
          inputMode="decimal"
          defaultValue={value("engineHours")}
          error={errors.engineHours?.[0]}
        />
        <Field
          // Re-mount once the local date is known so the default is the user's own "today".
          key={today}
          label="Date"
          name="readOn"
          type="date"
          required
          max={today || undefined}
          defaultValue={value("readOn") || today}
          error={errors.readOn?.[0]}
        />
      </div>
      <details className="text-sm" open={checked("odometerReset") || checked("hourMeterReset")}>
        <summary className="cursor-pointer text-muted hover:text-foreground">Meter replaced or reset?</summary>
        <div className="mt-3 space-y-3">
          <CheckboxField
            label="The odometer was replaced or reset"
            name="odometerReset"
            defaultChecked={checked("odometerReset")}
            hint="Enter what the new odometer shows. Lifetime miles carry on from the old one."
          />
          <CheckboxField
            label="The hour meter was replaced or reset"
            name="hourMeterReset"
            defaultChecked={checked("hourMeterReset")}
            hint="Enter what the new hour meter shows. Lifetime hours carry on from the old one."
          />
        </div>
      </details>
    </>
  );
}

/** "Update mileage": records a new reading. */
export function AddReadingForm({ sledId }: { sledId: string }) {
  const [state, formAction] = useActionState(addReading, {});
  return (
    <form action={formAction} className="space-y-4" noValidate key={state.savedAt ?? "form"}>
      <input type="hidden" name="sledId" value={sledId} />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok && state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <MeterFields state={state.ok ? {} : state} />
      <div className="sm:w-56">
        <SubmitButton pendingText="Saving…">Save reading</SubmitButton>
      </div>
    </form>
  );
}

/** "Fix last reading": corrects (or, for owners and editors, removes) the newest reading. */
export function FixLastReadingForm({
  sledId,
  reading,
  canRemove,
}: {
  sledId: string;
  reading: LastReading;
  canRemove: boolean;
}) {
  const [state, formAction] = useActionState(fixLastReading, {});
  return (
    <details
      className="rounded-2xl border border-white/10 bg-surface/40 open:bg-surface/60"
      open={Boolean(state.error)}
      data-testid="fix-reading"
    >
      <summary className="cursor-pointer list-none px-5 py-4 font-semibold marker:hidden">
        Fix last reading
        <span className="ml-2 text-sm font-normal text-muted">from {formatDate(reading.readOn)}</span>
      </summary>
      <form action={formAction} className="space-y-4 border-t border-white/10 p-5" noValidate key={`${reading.id}-${reading.version}`}>
        <input type="hidden" name="sledId" value={sledId} />
        <input type="hidden" name="readingId" value={reading.id} />
        <input type="hidden" name="version" value={reading.version} />
        {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
        <p className="text-sm text-muted">
          Corrections are kept in this snowmobile&apos;s history, so earlier values can be restored later.
        </p>
        <MeterFields
          state={state}
          defaults={{
            odometer: reading.odometer == null ? "" : String(reading.odometer),
            engineHours: reading.engineHours == null ? "" : String(reading.engineHours),
            readOn: reading.readOn,
            odometerReset: reading.odometerReset,
            hourMeterReset: reading.hourMeterReset,
          }}
        />
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:w-56">
            <SubmitButton pendingText="Saving…">Save correction</SubmitButton>
          </div>
          {canRemove ? (
            <Button
              type="submit"
              name="intent"
              value="remove"
              variant="ghost"
              size="lg"
              formNoValidate
              onClick={(event) => {
                if (!window.confirm("Remove the last reading? It stays in this snowmobile's history.")) {
                  event.preventDefault();
                }
              }}
            >
              Remove last reading
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
