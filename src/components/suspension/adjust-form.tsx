"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { saveAdjustment, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { describeChange, revisionChanges } from "@/lib/suspension/diff";
import {
  ZONE_GROUPS,
  ZONE_LABEL,
  settingsInZone,
  type Snapshot,
  type SuspensionSetting,
  type SuspensionZone,
} from "@/lib/suspension/types";
import { checkSettingValue } from "@/lib/suspension/validation";
import { randomUuid } from "@/lib/uuid";

const CONFLICT = "This setup was changed by someone else. Reload it and try again.";

/**
 * Record an adjustment to a setup: every setting of the sled with its current
 * value filled in; change only what you adjusted. Unchanged values carry
 * forward. Mileage and engine hours are copied from the sled's current
 * readings and can be edited; they never create or change a reading.
 *
 * One idempotency key per opened form: a double submit, or a retry after a
 * lost response, can't save twice. The base revision is the one the form was
 * opened on, so a save after someone else's is refused with a reload message.
 */
export function AdjustForm({
  setupId,
  setupName,
  baseRevisionId,
  values,
  settings,
  focusZone,
  odometer,
  engineHours,
  onDone,
}: {
  setupId: string;
  setupName: string;
  baseRevisionId: string;
  values: Snapshot;
  settings: SuspensionSetting[];
  focusZone?: SuspensionZone | null;
  odometer: number | null;
  engineHours: number | null;
  onDone: (result: SuspensionActionState) => void;
}) {
  const router = useRouter();
  const [key] = useState(randomUuid);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const zoneRef = useRef<HTMLFieldSetElement>(null);
  const [state, action] = useActionState<SuspensionActionState, FormData>(async (prev, formData) => {
    const result = await saveAdjustment(prev, formData);
    if (result.ok) onDone(result);
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;

  // Start at the zone that was selected on the map.
  useEffect(() => {
    zoneRef.current?.scrollIntoView({ block: "start" });
    zoneRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }, []);

  // A live preview of what will be saved (the server checks again).
  const preview: Snapshot = {};
  /** Values typed so far that the database would refuse (shown right away; the server checks again). */
  const invalid: Record<string, string> = {};
  for (const setting of settings) {
    const raw = edited[setting.id] ?? values[setting.id]?.value ?? "";
    const check = checkSettingValue(setting.valueType, raw, setting.name);
    if (!check.ok) {
      invalid[setting.id] = check.error;
      if (values[setting.id]) preview[setting.id] = values[setting.id];
      continue;
    }
    if (check.value)
      preview[setting.id] = { value: check.value, name: setting.name, zone: setting.zone, unit: setting.unit, type: setting.valueType };
  }
  const invalidCount = Object.keys(invalid).length;
  const current: Snapshot = Object.fromEntries(settings.flatMap((s) => (values[s.id] ? [[s.id, values[s.id]]] : [])));
  const changes = revisionChanges(current, preview, settings);
  const conflict = state.error === CONFLICT;

  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="setupId" value={setupId} />
      <input type="hidden" name="baseRevisionId" value={baseRevisionId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      {state.error && !state.fieldErrors ? (
        <Alert tone="error">
          {state.error}
          {conflict ? (
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              onClick={() => {
                router.refresh();
                onDone({});
              }}
            >
              <RefreshCw aria-hidden className="size-4" />
              Reload
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {state.fieldErrors && Object.keys(errors).some((k) => k.startsWith("value.")) ? (
        <Alert tone="error">Check the highlighted values.</Alert>
      ) : null}

      {ZONE_GROUPS.flatMap((group) => group.zones).map((zone) => {
        const list = settingsInZone(settings, zone);
        if (!list.length) return null;
        return (
          <fieldset
            key={zone}
            ref={zone === focusZone ? zoneRef : undefined}
            className={cn(
              "scroll-mt-4 rounded-xl border px-4 pb-4 pt-1",
              zone === focusZone ? "border-accent/60 bg-accent/5" : "border-white/10",
            )}
            data-testid="adjust-zone"
            data-zone={zone}
          >
            <legend className="px-1 text-sm font-semibold uppercase tracking-[0.15em] text-foreground/90">{ZONE_LABEL[zone]}</legend>
            <div className="space-y-3">
              {list.map((setting) => {
                const name = `value.${setting.id}`;
                const before = values[setting.id]?.value ?? "";
                const now = edited[setting.id] ?? before;
                const changed = now.trim() !== before;
                const error = errors[name]?.[0] ?? (edited[setting.id] !== undefined ? invalid[setting.id] : undefined);
                return (
                  <ValueInput
                    key={setting.id}
                    name={name}
                    label={setting.name}
                    accessibleName={`${ZONE_LABEL[zone]}: ${setting.name}`}
                    unit={setting.valueType === "number" ? setting.unit : null}
                    numeric={setting.valueType === "number"}
                    defaultValue={v?.[name] ?? before}
                    changedFrom={changed ? before || "blank" : null}
                    error={error}
                    onChange={(value) => setEdited((map) => ({ ...map, [setting.id]: value }))}
                  />
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <TextareaField
        label="What did you change and why? (optional)"
        name="note"
        maxLength={2000}
        defaultValue={v?.note ?? ""}
        error={errors.note?.[0]}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Mileage"
          name="odometer"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v?.odometer ?? odometer?.toString() ?? ""}
          error={errors.odometer?.[0]}
        />
        <Field
          label="Engine hours"
          name="engineHours"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v?.engineHours ?? engineHours?.toString() ?? ""}
          error={errors.engineHours?.[0]}
        />
      </div>
      <p className="-mt-3 text-sm text-muted">
        Copied from the current readings. Changing them here doesn&apos;t change the sled&apos;s readings.
      </p>

      <FormActions className="space-y-3">
        <div aria-live="polite" className="text-sm" data-testid="adjust-changes">
          {invalidCount ? (
            <p className="font-semibold text-accent-hot">
              Fix {invalidCount} value{invalidCount === 1 ? "" : "s"} before saving.
            </p>
          ) : null}
          {changes.length ? (
            <>
              <p className="font-semibold">
                {changes.length} change{changes.length === 1 ? "" : "s"} · saved as a new revision of {setupName}
              </p>
              <ul className="mt-1 max-h-20 overflow-y-auto text-muted">
                {changes.map((change) => (
                  <li key={change.settingId}>
                    {ZONE_LABEL[change.zone]} · {describeChange(change)}
                  </li>
                ))}
              </ul>
            </>
          ) : invalidCount ? null : (
            <p className="text-muted">No changes yet. Change a value to save an adjustment.</p>
          )}
        </div>
        <SubmitButton pendingText="Saving…">Save adjustment</SubmitButton>
      </FormActions>
    </form>
  );
}

function ValueInput({
  name,
  label,
  accessibleName,
  unit,
  numeric,
  defaultValue,
  changedFrom,
  error,
  onChange,
}: {
  name: string;
  label: string;
  accessibleName: string;
  unit: string | null;
  numeric: boolean;
  defaultValue: string;
  changedFrom: string | null;
  error?: string;
  onChange: (value: string) => void;
}) {
  const id = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  return (
    <div className="space-y-1" data-testid="adjust-value" data-changed={changedFrom ? "true" : undefined}>
      <label className="flex items-center gap-3">
        <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground/90">{label}</span>
        <span className="relative flex w-40 shrink-0 items-center sm:w-48">
          <input
            name={name}
            aria-label={accessibleName}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : changedFrom ? `${id}-was` : undefined}
            inputMode={numeric ? "decimal" : "text"}
            data-allow-negative={numeric ? "true" : undefined}
            autoComplete="off"
            maxLength={200}
            defaultValue={defaultValue}
            onChange={(event) => onChange(event.target.value)}
            className={cn(
              "block h-12 w-full rounded-lg border bg-black/30 px-3 text-base text-foreground placeholder:text-muted/70",
              "focus:outline-2 focus:outline-offset-0 focus:outline-accent",
              numeric && "text-right font-semibold tabular-nums",
              numeric && unit && "pr-16",
              error ? "border-accent" : changedFrom ? "border-accent-hot/70 bg-accent-hot/5" : "border-white/15",
            )}
          />
          {numeric && unit ? (
            <span aria-hidden className="pointer-events-none absolute right-3 max-w-14 truncate text-xs text-muted">
              {unit}
            </span>
          ) : null}
        </span>
      </label>
      {error ? (
        <p id={`${id}-error`} className="text-right text-sm text-accent-hot">
          {error}
        </p>
      ) : changedFrom ? (
        <p id={`${id}-was`} className="text-right text-xs text-accent-hot" data-testid="changed-from">
          was {changedFrom}
        </p>
      ) : null}
    </div>
  );
}
