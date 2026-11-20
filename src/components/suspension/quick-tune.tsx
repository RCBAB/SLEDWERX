"use client";

import { AlertTriangle, Camera, Link2, Minus, Plus, Split, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { saveConfiguration, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { formatValue } from "@/lib/suspension/diff";
import {
  QUICK_TUNE_SECTIONS,
  invalidNumbers,
  isStepUnit,
  numberDelta,
  pendingChanges,
  sameNumber,
  sectionRows,
  shownValue,
  stepValue,
  type PendingValues,
  type QuickTuneRow,
} from "@/lib/suspension/quick-tune";
import {
  configName,
  type Equipment,
  type Snapshot,
  type SuspensionRevision,
  type SuspensionSetting,
  type SuspensionZone,
} from "@/lib/suspension/types";
import { randomUuid } from "@/lib/uuid";
import { dislikeWarning, matchingConfigurations } from "@/lib/suspension/warnings";

/**
 * Quick Tune: every setting on one scrolling page in five sections. Change as
 * many values as needed (large − / + for clicks, typed numbers for
 * measurements), see the saved value and the difference next to each change,
 * then Save Adjustments once: that saves the next Trail configuration (active)
 * with everything unchanged carried forward. Discard Changes drops the edits.
 * Left and right ski shocks with the same setting are adjusted together unless
 * split.
 */
export function QuickTune({
  sledId,
  settings,
  active,
  installed,
  revisions,
  canAdjust,
  canManage,
  odometer,
  engineHours,
  onSaved,
  onDirtyChange,
  onAddSetting,
  onPhotos,
}: {
  sledId: string;
  settings: SuspensionSetting[];
  active: SuspensionRevision | undefined;
  installed: Equipment;
  revisions: SuspensionRevision[];
  canAdjust: boolean;
  canManage: boolean;
  odometer: number | null;
  engineHours: number | null;
  onSaved: (result: SuspensionActionState) => void;
  onDirtyChange: (dirty: boolean) => void;
  onAddSetting: (zone: SuspensionZone) => void;
  onPhotos: (setting: SuspensionSetting) => void;
}) {
  const saved: Snapshot = useMemo(() => active?.values ?? {}, [active]);
  const [pending, setPending] = useState<PendingValues>({});
  const [split, setSplit] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState("");
  const [key, setKey] = useState(randomUuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(() => pendingChanges(pending, saved, settings), [pending, saved, settings]);
  const invalid = useMemo(() => new Set(invalidNumbers(pending, settings)), [pending, settings]);
  const count = Object.keys(changes).length;
  const dirty = count > 0 || invalid.size > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Would the result be a configuration that was disliked before?
  const warning = useMemo(() => {
    if (!count || invalid.size) return null;
    const result: Snapshot = { ...saved };
    for (const [id, value] of Object.entries(changes)) {
      const setting = settings.find((s) => s.id === id);
      if (!setting) continue;
      if (value === null) delete result[id];
      else result[id] = { value, name: setting.name, zone: setting.zone, unit: setting.unit, type: setting.valueType };
    }
    const matches = matchingConfigurations({ values: result, equipment: installed }, revisions);
    return { dislike: dislikeWarning(matches), same: matches.map((r) => configName(r.configNumber)) };
  }, [changes, count, invalid.size, saved, settings, installed, revisions]);

  const setValue = (ids: string[], value: string) =>
    setPending((p) => {
      const next = { ...p };
      for (const id of ids) {
        if ((saved[id]?.value ?? "") === value) delete next[id];
        else next[id] = value;
      }
      return next;
    });

  const discard = () => {
    setPending({});
    setNote("");
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveConfiguration({
        sledId,
        baseRevisionId: active?.id ?? null,
        changes,
        note,
        odometer,
        engineHours,
        idempotencyKey: key,
      });
      if (result.ok) {
        setPending({});
        setNote("");
        setKey(randomUuid());
        onSaved(result);
      } else {
        setError(result.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      // Same key on retry: a save that did go through is never repeated.
      setError("Couldn't reach SledWerx. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="quick-tune">
      {QUICK_TUNE_SECTIONS.map((section, n) => {
        const rows = sectionRows(settings, section.id);
        return (
          <section
            key={section.id}
            aria-labelledby={`qt-${section.id}`}
            className="rounded-2xl border border-white/10 bg-surface/70"
            data-testid="quick-tune-section"
            data-section={section.id}
          >
            <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
              <h3 id={`qt-${section.id}`} className="font-display text-xl font-bold uppercase tracking-wide">
                <span className="mr-2 text-accent-hot">{n + 1}</span>
                {section.label}
              </h3>
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onAddSetting(section.zones[0])}
                  aria-label={`Add setting to ${section.label}`}
                >
                  <Plus aria-hidden className="size-4" />
                  Add
                </Button>
              ) : null}
            </header>
            {rows.length ? (
              <ul className="divide-y divide-white/10">
                {rows.map((row) => (
                  <Row
                    key={row.key}
                    row={row}
                    pending={pending}
                    saved={saved}
                    invalid={invalid}
                    split={split.has(row.key)}
                    canAdjust={canAdjust && !busy}
                    onSplit={(on) =>
                      setSplit((s) => {
                        const next = new Set(s);
                        if (on) next.add(row.key);
                        else next.delete(row.key);
                        return next;
                      })
                    }
                    setValue={setValue}
                    onPhotos={onPhotos}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-muted sm:px-5">No settings here yet.</p>
            )}
          </section>
        );
      })}

      {canAdjust && dirty ? <div aria-hidden className="h-48 sm:h-40" /> : null}
      {canAdjust && dirty ? (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-white/15 bg-background/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_32px_rgba(0,0,0,0.5)] backdrop-blur"
          role="region"
          aria-label="Unsaved adjustments"
          data-testid="quick-tune-bar"
        >
          <div className="mx-auto max-w-6xl space-y-3">
            {error ? <Alert tone="error">{error}</Alert> : null}
            {warning?.dislike ? (
              <p className="flex gap-2 text-sm text-amber-100" data-testid="dislike-warning">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>
                  {warning.dislike.message} ({warning.dislike.configurations.join(", ")})
                </span>
              </p>
            ) : warning?.same.length ? (
              <p className="text-sm text-muted" data-testid="same-as">
                These settings match {warning.same.join(", ")}.
              </p>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground/90">
                  {invalid.size ? (
                    <span className="text-accent-hot">Fix the highlighted value{invalid.size === 1 ? "" : "s"} to save.</span>
                  ) : (
                    <>
                      <span data-testid="change-count">
                        {count} change{count === 1 ? "" : "s"}
                      </span>{" "}
                      · saved as the next Trail configuration · notes (optional)
                    </>
                  )}
                </span>
                <input
                  type="text"
                  value={note}
                  maxLength={2000}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What did you change and why?"
                  aria-label="Notes (optional)"
                  className="mt-1 h-12 w-full rounded-lg border border-white/15 bg-surface px-3 text-base text-foreground placeholder:text-muted focus:outline focus:outline-2 focus:outline-accent"
                />
              </label>
              <div className="grid grid-cols-2 gap-3 sm:flex">
                <Button type="button" variant="secondary" size="lg" className="h-12" onClick={discard} disabled={busy}>
                  <Undo2 aria-hidden className="size-4" />
                  Discard Changes
                </Button>
                <Button type="button" size="lg" className="h-12" onClick={() => void save()} disabled={busy || invalid.size > 0 || !count}>
                  {busy ? "Saving…" : "Save Adjustments"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  row,
  pending,
  saved,
  invalid,
  split,
  canAdjust,
  onSplit,
  setValue,
  onPhotos,
}: {
  row: QuickTuneRow;
  pending: PendingValues;
  saved: Snapshot;
  invalid: ReadonlySet<string>;
  split: boolean;
  canAdjust: boolean;
  onSplit: (on: boolean) => void;
  setValue: (ids: string[], value: string) => void;
  onPhotos: (setting: SuspensionSetting) => void;
}) {
  if (row.kind === "single") {
    return (
      <li className="px-4 py-3 sm:px-5" data-testid="qt-row" data-setting-id={row.setting.id}>
        <Control
          label={row.label}
          side={row.side}
          setting={row.setting}
          value={shownValue(pending, saved, row.setting.id)}
          before={saved[row.setting.id]?.value ?? null}
          invalid={invalid.has(row.setting.id)}
          canAdjust={canAdjust}
          onChange={(v) => setValue([row.setting.id], v)}
          onPhotos={onPhotos}
        />
      </li>
    );
  }
  const left = shownValue(pending, saved, row.left.id);
  const right = shownValue(pending, saved, row.right.id);
  const differ = left !== right;
  const separate = split || differ;
  return (
    <li className="px-4 py-3 sm:px-5" data-testid="qt-row" data-pair={row.key} data-separate={separate ? "true" : "false"}>
      {separate ? (
        <div className="space-y-3">
          <Control
            label={row.label}
            side="Left"
            setting={row.left}
            value={left}
            before={saved[row.left.id]?.value ?? null}
            invalid={invalid.has(row.left.id)}
            canAdjust={canAdjust}
            onChange={(v) => setValue([row.left.id], v)}
            onPhotos={onPhotos}
          />
          <Control
            label={row.label}
            side="Right"
            setting={row.right}
            value={right}
            before={saved[row.right.id]?.value ?? null}
            invalid={invalid.has(row.right.id)}
            canAdjust={canAdjust}
            onChange={(v) => setValue([row.right.id], v)}
            onPhotos={onPhotos}
          />
          {canAdjust ? (
            differ ? (
              <p className="text-xs text-muted">Left and right differ, so they&apos;re adjusted separately.</p>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onSplit(false)}
                aria-label={`Adjust ${row.label} on both ski shocks together`}
              >
                <Link2 aria-hidden className="size-4" />
                Adjust both together
              </Button>
            )
          ) : null}
        </div>
      ) : (
        <div className="space-y-1">
          <Control
            label={row.label}
            side="Both ski shocks"
            setting={row.left}
            value={left}
            before={saved[row.left.id]?.value ?? null}
            invalid={invalid.has(row.left.id) || invalid.has(row.right.id)}
            canAdjust={canAdjust}
            onChange={(v) => setValue([row.left.id, row.right.id], v)}
            onPhotos={onPhotos}
            photosOf={[row.left, row.right]}
          />
          {canAdjust ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onSplit(true)}
              aria-label={`Adjust ${row.label} left and right separately`}
            >
              <Split aria-hidden className="size-4" />
              Left and right separately
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function Control({
  label,
  side,
  setting,
  value,
  before,
  invalid,
  canAdjust,
  onChange,
  onPhotos,
  photosOf,
}: {
  label: string;
  side: string | null;
  setting: SuspensionSetting;
  value: string;
  before: string | null;
  invalid: boolean;
  canAdjust: boolean;
  onChange: (value: string) => void;
  onPhotos: (setting: SuspensionSetting) => void;
  photosOf?: SuspensionSetting[];
}) {
  const name = side ? `${label} (${side})` : label;
  const number = setting.valueType === "number";
  const stepper = number && isStepUnit(setting.unit);
  const unit = setting.valueType === "text" ? null : setting.unit;
  const after = value.trim() === "" ? null : value;
  const changed = number ? (after === null ? before !== null : before === null || !sameNumber(after, before)) : (after ?? null) !== before;
  const delta = number && changed ? numberDelta(before, after) : null;
  const withPhotos = (photosOf ?? [setting]).filter((s) => s.photos.length);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      data-testid="qt-control"
      data-changed={changed ? "true" : "false"}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-base font-semibold" data-testid="qt-name">
          {label}
          {side ? <span className="ml-2 text-sm font-medium text-muted">{side}</span> : null}
        </p>
        {changed && !invalid ? (
          <p className="mt-0.5 text-sm text-accent-hot" data-testid="qt-change">
            {after === null
              ? `Cleared (was ${formatValue(before, unit)})`
              : before === null
                ? "New value (was blank)"
                : `Was ${formatValue(before, unit)}${delta ? ` · ${delta}` : ""}`}
          </p>
        ) : invalid ? (
          <p className="mt-0.5 text-sm text-accent-hot">Enter a number.</p>
        ) : null}
        {withPhotos.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPhotos(s)}
            aria-label={`Reference photos of ${s.name}`}
            className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-muted hover:bg-white/5 hover:text-foreground"
          >
            <Camera aria-hidden className="size-4" />
            {s.photos.length} reference photo{s.photos.length === 1 ? "" : "s"}
          </button>
        ))}
      </div>

      {canAdjust ? (
        <div className={cn("flex items-center gap-2", !number && "w-full sm:w-auto")}>
          {stepper ? (
            <button
              type="button"
              onClick={() => {
                const next = stepValue(value, -1);
                if (next !== null) onChange(next);
              }}
              aria-label={`Decrease ${name}`}
              className="grid size-14 shrink-0 place-items-center rounded-xl bg-white/10 text-foreground ring-1 ring-white/15 hover:bg-white/15 active:bg-white/20"
            >
              <Minus aria-hidden className="size-6" />
            </button>
          ) : null}
          <input
            type="text"
            inputMode={number ? "decimal" : "text"}
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={name}
            aria-invalid={invalid || undefined}
            maxLength={200}
            className={cn(
              "h-14 rounded-xl border bg-background/60 px-2 text-center font-display text-2xl font-bold tabular-nums text-foreground focus:outline focus:outline-2 focus:outline-accent",
              number ? "w-24" : "w-full min-w-0 text-lg sm:w-56",
              invalid ? "border-accent" : changed ? "border-accent/60" : "border-white/15",
            )}
          />
          {stepper ? (
            <button
              type="button"
              onClick={() => {
                const next = stepValue(value, 1);
                if (next !== null) onChange(next);
              }}
              aria-label={`Increase ${name}`}
              className="grid size-14 shrink-0 place-items-center rounded-xl bg-white/10 text-foreground ring-1 ring-white/15 hover:bg-white/15 active:bg-white/20"
            >
              <Plus aria-hidden className="size-6" />
            </button>
          ) : null}
          {unit ? <span className="w-14 shrink-0 text-sm text-muted">{unit}</span> : null}
        </div>
      ) : (
        <p className={cn("shrink-0 font-display text-2xl font-bold tabular-nums", value === "" && "text-muted")} data-testid="qt-value">
          {formatValue(value || null, unit)}
        </p>
      )}
    </div>
  );
}
