"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useActionState, useId, useRef, useState } from "react";

import { deleteSetting, moveSetting, saveSetting, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  INPUT_METHOD_LABEL,
  INPUT_METHODS,
  TURNS_INPUT_AVAILABLE,
  UNIT_SUGGESTIONS,
  VALUE_TYPE_LABEL,
  ZONE_GROUPS,
  ZONE_LABEL,
  measures,
  settingsInZone,
  type InputMethods,
  type SettingValueType,
  type SuspensionSetting,
  type SuspensionZone,
} from "@/lib/suspension/types";

import { useRun } from "./shared";

/**
 * The sled's one settings list (shared by all its setups), by zone. Owners and
 * editors add, edit, reorder and remove settings. Nothing is pre-filled.
 */
export function SettingsEditor({
  settings,
  onAdd,
  onEdit,
}: {
  settings: SuspensionSetting[];
  onAdd: (zone?: SuspensionZone) => void;
  onEdit: (setting: SuspensionSetting) => void;
}) {
  const { busy, error, run } = useRun();
  return (
    <div className="space-y-4" data-testid="settings-editor">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {settings.length === 0 ? (
        <p className="text-muted" data-testid="no-settings">
          No settings yet. Add the adjusters you want to track on this snowmobile, for example the compression clicks on a shock. Nothing is
          filled in for you.
        </p>
      ) : null}
      {ZONE_GROUPS.map((group) => (
        <div key={group.id} className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{group.label}</h3>
          {group.zones.map((zone) => {
            const list = settingsInZone(settings, zone);
            return (
              <div key={zone} className="rounded-xl border border-white/10 bg-background/30" data-testid="settings-zone" data-zone={zone}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <p className="font-semibold">{ZONE_LABEL[zone]}</p>
                  <Button type="button" variant="ghost" onClick={() => onAdd(zone)} aria-label={`Add setting to ${ZONE_LABEL[zone]}`}>
                    <Plus aria-hidden className="size-4" />
                    Add
                  </Button>
                </div>
                {list.length ? (
                  <ul className="divide-y divide-white/10 border-t border-white/10">
                    {list.map((setting, n) => (
                      <li key={setting.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="setting-row">
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-medium" data-testid="setting-name">
                            {setting.name}
                          </p>
                          <p className="text-xs text-muted">
                            {VALUE_TYPE_LABEL[setting.valueType]}
                            {setting.valueType === "number" && setting.unit ? ` · ${setting.unit}` : ""}
                            {setting.photos.length
                              ? ` · ${setting.photos.length} reference photo${setting.photos.length === 1 ? "" : "s"}`
                              : ""}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <IconButton
                            label={`Move ${setting.name} up`}
                            disabled={busy || n === 0}
                            onClick={() => void run(() => moveSetting(setting.id, "up"))}
                          >
                            <ArrowUp aria-hidden className="size-4" />
                          </IconButton>
                          <IconButton
                            label={`Move ${setting.name} down`}
                            disabled={busy || n === list.length - 1}
                            onClick={() => void run(() => moveSetting(setting.id, "down"))}
                          >
                            <ArrowDown aria-hidden className="size-4" />
                          </IconButton>
                          <IconButton label={`Edit ${setting.name}`} disabled={busy} onClick={() => onEdit(setting)}>
                            <Pencil aria-hidden className="size-4" />
                          </IconButton>
                          <IconButton
                            label={`Remove ${setting.name}`}
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove “${setting.name}”? Its values stay in the history. It can be restored from Recently Deleted for 30 days.`,
                                )
                              )
                                void run(() => deleteSetting(setting.id, setting.version));
                            }}
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </IconButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function IconButton({ label, children, className, ...props }: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "grid size-11 place-items-center rounded-lg border border-white/10 text-muted hover:bg-white/5 hover:text-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Add a setting (optionally in a given zone) or edit one. */
export function SettingForm({
  sledId,
  setting,
  zone,
  onDone,
}: {
  sledId: string;
  setting?: SuspensionSetting;
  zone?: SuspensionZone;
  onDone: () => void;
}) {
  const listId = `units-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, action] = useActionState<SuspensionActionState, FormData>(async (prev, formData) => {
    const result = await saveSetting(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const [valueType, setValueType] = useState<SettingValueType>((v?.valueType as SettingValueType) ?? setting?.valueType ?? "number");
  const [inputMethods, setInputMethods] = useState<InputMethods>(
    (INPUT_METHODS as readonly string[]).includes(v?.inputMethods ?? "")
      ? (v?.inputMethods as InputMethods)
      : (setting?.inputMethods ?? "measurement"),
  );
  const unitRef = useRef<HTMLInputElement>(null);
  const chooseMethods = (next: InputMethods) => {
    setInputMethods(next);
    // A measurement adjusted in turns defaults to inches when no unit is set (it can be changed).
    if (next !== "measurement" && measures(next) && unitRef.current && !unitRef.current.value.trim()) unitRef.current.value = "in";
  };

  return (
    <form action={action} className="space-y-5" noValidate>
      {setting ? (
        <>
          <input type="hidden" name="settingId" value={setting.id} />
          <input type="hidden" name="version" value={setting.version} />
        </>
      ) : (
        <input type="hidden" name="sledId" value={sledId} />
      )}
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        label="Setting name"
        name="name"
        maxLength={80}
        autoComplete="off"
        placeholder="e.g. Compression, Rebound, Preload"
        defaultValue={v?.name ?? setting?.name ?? ""}
        error={errors.name?.[0]}
      />
      <SelectField label="Where on the sled" name="zone" defaultValue={v?.zone ?? setting?.zone ?? zone ?? ""} error={errors.zone?.[0]}>
        <option value="" disabled>
          Choose…
        </option>
        {ZONE_GROUPS.map((group) => (
          <optgroup key={group.id} label={group.label}>
            {group.zones.map((z) => (
              <option key={z} value={z}>
                {ZONE_LABEL[z]}
              </option>
            ))}
          </optgroup>
        ))}
      </SelectField>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-foreground/90">Value</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["number", "Number", "Clicks, turns, mm…"],
              ["text", "Text", "e.g. “Stiff spring”"],
            ] as const
          ).map(([value, title, hint]) => (
            <label
              key={value}
              className={cn(
                "flex min-h-14 cursor-pointer flex-col justify-center rounded-lg px-3 py-2 ring-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                valueType === value ? "bg-accent/10 ring-2 ring-accent" : "bg-white/5 ring-white/10",
              )}
            >
              <input
                type="radio"
                name="valueType"
                value={value}
                checked={valueType === value}
                onChange={() => setValueType(value)}
                className="sr-only"
              />
              <span className="text-sm font-bold">{title}</span>
              <span className="text-xs text-muted">{hint}</span>
            </label>
          ))}
        </div>
        {errors.valueType?.[0] ? <p className="mt-1 text-sm text-accent-hot">{errors.valueType[0]}</p> : null}
      </fieldset>
      {valueType === "number" ? (
        <fieldset data-testid="input-methods">
          <legend className="mb-1.5 text-sm font-medium text-foreground/90">How it&apos;s adjusted</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {INPUT_METHODS.map((value) => {
              const disabled = !TURNS_INPUT_AVAILABLE && value !== "measurement" && setting?.inputMethods !== value;
              return (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-14 flex-col justify-center rounded-lg px-3 py-2 ring-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    inputMethods === value ? "bg-accent/10 ring-2 ring-accent" : "bg-white/5 ring-white/10",
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  )}
                >
                  <input
                    type="radio"
                    name="inputMethods"
                    value={value}
                    checked={inputMethods === value}
                    disabled={disabled}
                    onChange={() => chooseMethods(value)}
                    className="sr-only"
                  />
                  <span className="text-sm font-bold">{INPUT_METHOD_LABEL[value]}</span>
                  <span className="text-xs text-muted">
                    {disabled
                      ? "Available with Quick Tune Turns"
                      : value === "measurement"
                        ? "Enter the value"
                        : value === "turns"
                          ? "+/− turns"
                          : "Either one"}
                  </span>
                </label>
              );
            })}
          </div>
          {errors.inputMethods?.[0] ? <p className="mt-1 text-sm text-accent-hot">{errors.inputMethods[0]}</p> : null}
        </fieldset>
      ) : (
        <input type="hidden" name="inputMethods" value="measurement" />
      )}
      {valueType === "number" ? (
        // Turns only has no measurement unit: hidden, but the stored unit is kept as it is.
        <div className={cn("space-y-2", !measures(inputMethods) && "hidden")} data-testid="unit-fields">
          <Field
            ref={unitRef}
            label="Unit (optional)"
            name="unit"
            maxLength={20}
            autoComplete="off"
            list={listId}
            defaultValue={v?.unit ?? setting?.unit ?? ""}
            hint="Pick a suggestion or type your own."
            error={errors.unit?.[0]}
          />
          <datalist id={listId}>
            {UNIT_SUGGESTIONS.map((unit) => (
              <option key={unit} value={unit} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Unit suggestions">
            {UNIT_SUGGESTIONS.map((unit) => (
              <UnitChip key={unit} unit={unit} />
            ))}
          </div>
        </div>
      ) : (
        <input type="hidden" name="unit" value="" />
      )}
      <TextareaField
        label="Notes (optional)"
        name="notes"
        maxLength={2000}
        defaultValue={v?.notes ?? setting?.notes ?? ""}
        hint="For example where the adjuster is, or which way is softer."
        error={errors.notes?.[0]}
      />
      <FormActions>
        <SubmitButton pendingText="Saving…">{setting ? "Save setting" : "Add setting"}</SubmitButton>
      </FormActions>
    </form>
  );
}

/** Tapping a suggestion fills the unit field; any other unit can still be typed. */
function UnitChip({ unit }: { unit: string }) {
  return (
    <button
      type="button"
      className="min-h-11 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-foreground/90 hover:bg-white/10"
      onClick={(event) => {
        const input = event.currentTarget.closest("form")?.querySelector<HTMLInputElement>('input[name="unit"]');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, unit);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      }}
    >
      {unit}
    </button>
  );
}
