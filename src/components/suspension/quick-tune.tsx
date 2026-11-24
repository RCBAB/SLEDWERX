"use client";

import { AlertTriangle, Camera, Link2, Minus, Plus, Split, Undo2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { recordMeasurement, saveConfiguration, type SuspensionActionState } from "@/app/garage/suspension-actions";
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
import {
  LARGE_TURNS,
  displayValues,
  formatTurns,
  parseTurns,
  stepTurns,
  turnsOutstanding,
  type TrailTurns,
  type TrailTurnsMap,
} from "@/lib/suspension/turns";
import { randomUuid } from "@/lib/uuid";
import { dislikeWarning, matchingConfigurations } from "@/lib/suspension/warnings";

import { MeasurementPhotoButton } from "./measurement-photos";
import { ReminderChip } from "./reminders";

/** Measurement photos of the active configuration (Migration 10); null when there are none to show. */
export type MeasurementPhotoAccess = {
  configNumber: number;
  count: (settingId: string) => number;
  canAdd: boolean;
  open: (setting: SuspensionSetting, name: string) => void;
};
const MeasurementContext = createContext<MeasurementPhotoAccess | null>(null);

/** Measurement / Turns (Migration 12) for the rows: the active Trail's status and the pending turns. */
type TurnsAccess = {
  activeId: string | null;
  photoUploads: boolean;
  turnsOf: (settingId: string) => TrailTurns | undefined;
  pending: Record<string, string>;
  invalid: ReadonlySet<string>;
  setTurns: (ids: string[], text: string) => void;
  mode: (settingId: string) => "measurement" | "turns";
  setMode: (ids: string[], mode: "measurement" | "turns") => void;
  record: (settingId: string, value: string) => Promise<string | null>;
};
const TurnsContext = createContext<TurnsAccess | null>(null);

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
  onRecorded,
  photoUploads = false,
  measurement = null,
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
  /** A measurement was documented on the active Trail (no new Trail). */
  onRecorded?: (message: string) => void;
  /** Photo uploads are on (Photo Needed is shown only then). */
  photoUploads?: boolean;
  /** Measurement photos of the active configuration (photo changes never touch adjustments). */
  measurement?: MeasurementPhotoAccess | null;
}) {
  /** The values just saved, shown until the refreshed page brings them as the active configuration. */
  const [justSaved, setJustSaved] = useState<Snapshot | null>(null);
  const saved: Snapshot = useMemo(() => justSaved ?? active?.values ?? {}, [justSaved, active]);
  const [pending, setPending] = useState<PendingValues>({});
  // Migration 12: typed turns adjustments, Measurement / Turns choice per setting.
  const [justSavedTurns, setJustSavedTurns] = useState<TrailTurnsMap | null>(null);
  const activeTurns: TrailTurnsMap = useMemo(() => justSavedTurns ?? active?.turns ?? {}, [justSavedTurns, active]);
  const [pendingTurns, setPendingTurns] = useState<Record<string, string>>({});
  const [modes, setModes] = useState<Record<string, "measurement" | "turns">>({});
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [split, setSplit] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState("");
  const [key, setKey] = useState(randomUuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The active configuration changed (our own save arriving from the server,
  // new skis or carbides, someone else's save): keep anything typed, now
  // measured against the new active values. Making another configuration
  // active on purpose starts Quick Tune afresh (the page remounts it).
  const [baseId, setBaseId] = useState(active?.id ?? null);
  const activeId = active?.id ?? null;
  if (activeId !== baseId) {
    setBaseId(activeId);
    setJustSaved(null);
    setJustSavedTurns(null);
  }

  const changes = useMemo(() => pendingChanges(pending, saved, settings), [pending, saved, settings]);
  const turns = useMemo(() => {
    const result: Record<string, number> = {};
    for (const [id, text] of Object.entries(pendingTurns)) {
      const amount = parseTurns(text);
      if (amount !== null && amount !== 0 && settings.some((s) => s.id === id)) result[id] = amount;
    }
    return result;
  }, [pendingTurns, settings]);
  const invalidTurns = useMemo(
    () => new Set(Object.entries(pendingTurns).flatMap(([id, text]) => (text.trim() !== "" && parseTurns(text) === null ? [id] : []))),
    [pendingTurns],
  );
  const invalid = useMemo(() => new Set([...invalidNumbers(pending, settings), ...invalidTurns]), [pending, settings, invalidTurns]);
  const count = Object.keys(changes).length + Object.keys(turns).length;
  const large = Object.entries(turns).filter(([, amount]) => Math.abs(amount) > LARGE_TURNS);
  const dirty = count > 0 || invalid.size > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Would the result be a configuration that was disliked before? (Turns count: "+2.5 turns" must match too.)
  const warning = useMemo(() => {
    if (!count || invalid.size) return null;
    const next = nextTurns(activeTurns, turns, changes, settings);
    const result = applyChanges(saved, changes, settings);
    for (const id of Object.keys(turns)) delete result[id];
    const matches = matchingConfigurations({ values: displayValues(result, next, settings), equipment: installed }, revisions);
    return { dislike: dislikeWarning(matches), same: matches.map((r) => configName(r.configNumber)) };
  }, [changes, turns, activeTurns, count, invalid.size, saved, settings, installed, revisions]);

  const turnsAccess: TurnsAccess = {
    activeId,
    photoUploads,
    turnsOf: (id) => activeTurns[id],
    pending: pendingTurns,
    invalid: invalidTurns,
    setTurns: (ids, text) => {
      setConfirmLarge(false);
      setPendingTurns((p) => {
        const next = { ...p };
        for (const id of ids) {
          if (text.trim() === "" || parseTurns(text) === 0) delete next[id];
          else next[id] = text;
        }
        return next;
      });
    },
    mode: (id) => modes[id] ?? "measurement",
    setMode: (ids, mode) => {
      setModes((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, mode])) }));
      // A setting gets either a measurement or turns in one save, never both.
      if (mode === "turns") setPending((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !ids.includes(id))));
      else setPendingTurns((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !ids.includes(id))));
    },
    record: async (settingId, value) => {
      if (!activeId) return "Save a configuration first.";
      try {
        const result = await recordMeasurement({ revisionId: activeId, settingId, value });
        if (!result.ok) return result.error ?? "Something went wrong. Please try again.";
        const setting = settings.find((s) => s.id === settingId);
        onRecorded?.(
          `Measurement recorded for ${setting?.name ?? "the setting"} on ${active ? configName(active.configNumber) : "this Trail"}.`,
        );
        return null;
      } catch {
        return "Couldn't reach SledWerx. Check the connection and try again.";
      }
    },
  };

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
    setPendingTurns({});
    setConfirmLarge(false);
    setNote("");
    setError(null);
  };

  const save = async () => {
    // More than 20 turns in one adjustment: allowed, after a second tap.
    if (large.length && !confirmLarge) {
      setConfirmLarge(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await saveConfiguration({
        sledId,
        baseRevisionId: active?.id ?? null,
        changes,
        turns,
        note,
        odometer,
        engineHours,
        idempotencyKey: key,
      });
      if (result.ok) {
        // Show the saved values at once (not the previous ones) until the refresh arrives.
        const after = applyChanges(saved, changes, settings);
        for (const id of Object.keys(turns)) delete after[id];
        setJustSaved(after);
        setJustSavedTurns(nextTurns(activeTurns, turns, changes, settings));
        setPending({});
        setPendingTurns({});
        setConfirmLarge(false);
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
    <MeasurementContext.Provider value={measurement}>
      <TurnsContext.Provider value={turnsAccess}>
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
                {large.length ? (
                  <p className="flex gap-2 text-sm text-amber-100" data-testid="large-turns-warning">
                    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {large
                        .map(([id, amount]) => `${formatTurns(amount)} on ${settings.find((s) => s.id === id)?.name ?? "a setting"}`)
                        .join(", ")}{" "}
                      is more than {LARGE_TURNS} turns in one adjustment.{" "}
                      {confirmLarge ? "Tap Save Anyway to confirm." : "Check the amount before saving."}
                    </span>
                  </p>
                ) : null}
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
                    <Button
                      type="button"
                      size="lg"
                      className="h-12"
                      onClick={() => void save()}
                      disabled={busy || invalid.size > 0 || !count}
                    >
                      {busy ? "Saving…" : confirmLarge && large.length ? "Save Anyway" : "Save Adjustments"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </TurnsContext.Provider>
    </MeasurementContext.Provider>
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
  const tc = useContext(TurnsContext);
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
  // Migration 12: turns shown, typed or chosen differently on each side keep them separate,
  // and so does a measurement still to be documented (each side is measured on its own).
  const lt = tc?.turnsOf(row.left.id);
  const rt = tc?.turnsOf(row.right.id);
  const differ =
    left !== right ||
    (lt?.cumulative ?? null) !== (rt?.cumulative ?? null) ||
    (lt?.measurement ?? null) !== (rt?.measurement ?? null) ||
    (tc?.pending[row.left.id] ?? "") !== (tc?.pending[row.right.id] ?? "") ||
    tc?.mode(row.left.id) !== tc?.mode(row.right.id);
  const recording = row.left.inputMethods === "both" && (turnsOutstanding(lt) || turnsOutstanding(rt));
  const separate = split || differ || recording;
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
            ) : recording ? (
              <p className="text-xs text-muted">Record each side&apos;s measurement separately.</p>
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
            ids={[row.left.id, row.right.id]}
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
  ids,
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
  /** Settings this control changes together (left and right ski shocks). */
  ids?: string[];
}) {
  const name = side ? `${label} (${side})` : label;
  const number = setting.valueType === "number";
  const stepper = number && isStepUnit(setting.unit);
  const unit = setting.valueType === "text" ? null : setting.unit;
  const after = value.trim() === "" ? null : value;
  const changed = number ? (after === null ? before !== null : before === null || !sameNumber(after, before)) : (after ?? null) !== before;
  const delta = number && changed ? numberDelta(before, after) : null;
  const withPhotos = (photosOf ?? [setting]).filter((s) => s.photos.length);
  const measurement = useContext(MeasurementContext);
  const measured = (photosOf ?? [setting]).map((s, n) => ({
    setting: s,
    side: photosOf ? (n === 0 ? "L" : "R") : undefined,
    name: photosOf ? `${label} (${n === 0 ? "Left" : "Right"})` : name,
    count: measurement?.count(s.id) ?? 0,
  }));

  // Migration 12: how this setting is adjusted, and its status on the active Trail.
  const tc = useContext(TurnsContext);
  const targets = ids ?? [setting.id];
  const methods = setting.inputMethods;
  const t = tc?.turnsOf(setting.id);
  const outstanding = turnsOutstanding(t);
  const mode: "measurement" | "turns" =
    methods === "turns" ? "turns" : methods === "measurement" ? "measurement" : (tc?.mode(setting.id) ?? "measurement");
  const typedTurns = tc?.pending[setting.id] ?? "";
  const turnsInvalid = tc?.invalid.has(setting.id) ?? false;
  const amount = parseTurns(typedTurns);
  const [correcting, setCorrecting] = useState(false);
  const documented = t?.measurement != null;
  const recordMode = canAdjust && methods === "both" && mode === "measurement" && (outstanding || (documented && correcting));
  const turnsChanged = mode === "turns" && amount !== null && amount !== 0;
  const showChanged = mode === "measurement" && !recordMode && changed;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      data-testid="qt-control"
      data-setting={setting.id}
      data-input-methods={methods}
      data-changed={showChanged || turnsChanged ? "true" : "false"}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-base font-semibold" data-testid="qt-name">
          {label}
          {side ? <span className="ml-2 text-sm font-medium text-muted">{side}</span> : null}
        </p>
        <TurnsStatus turns={t} unit={unit} photoUploads={tc?.photoUploads ?? false} />
        {turnsChanged ? (
          <p className="mt-0.5 text-sm text-accent-hot" data-testid="qt-turns-change">
            {formatTurns(amount!)} ·{" "}
            {outstanding ? `total ${formatTurns(Math.round((t!.cumulative + amount!) * 100) / 100)}` : "measurement blank until recorded"}
          </p>
        ) : mode === "turns" && turnsInvalid ? (
          <p className="mt-0.5 text-sm text-accent-hot">Enter turns like +1, −0.5 or 2.25.</p>
        ) : showChanged && !invalid ? (
          <p className="mt-0.5 text-sm text-accent-hot" data-testid="qt-change">
            {after === null
              ? `Cleared (was ${formatValue(before, unit)})`
              : before === null
                ? "New value (was blank)"
                : `Was ${formatValue(before, unit)}${delta ? ` · ${delta}` : ""}`}
          </p>
        ) : invalid && mode === "measurement" ? (
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
        {measurement
          ? measured
              .filter((m) => m.count > 0 || measurement.canAdd)
              .map((m) => (
                <MeasurementPhotoButton
                  key={m.setting.id}
                  count={m.count}
                  name={m.name}
                  side={m.side}
                  configNumber={measurement.configNumber}
                  onClick={() => measurement.open(m.setting, m.name)}
                />
              ))
          : null}
        {canAdjust && methods === "both" && mode === "measurement" && documented && !outstanding && !correcting ? (
          <button
            type="button"
            onClick={() => setCorrecting(true)}
            aria-label={`Correct the recorded measurement of ${name}`}
            className="-ml-2 inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-muted underline-offset-4 hover:bg-white/5 hover:text-foreground hover:underline"
          >
            Correct recorded measurement
          </button>
        ) : null}
      </div>

      {canAdjust ? (
        <div className={cn("flex flex-col items-end gap-2", !number && "w-full sm:w-auto")}>
          {methods === "both" ? (
            <div className="inline-flex rounded-xl bg-white/5 p-1 ring-1 ring-white/10" role="group" aria-label={`How to adjust ${name}`}>
              {(["measurement", "turns"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => {
                    setCorrecting(false);
                    tc?.setMode(targets, m);
                  }}
                  className={cn(
                    "min-h-11 rounded-lg px-3 text-sm font-semibold",
                    mode === m ? "bg-accent text-background" : "text-muted hover:text-foreground",
                  )}
                >
                  {m === "measurement" ? "Measurement" : "Turns"}
                </button>
              ))}
            </div>
          ) : null}
          {mode === "turns" ? (
            <TurnsInput name={name} value={typedTurns} invalid={turnsInvalid} onChange={(text) => tc?.setTurns(targets, text)} />
          ) : recordMode ? (
            <RecordInput
              name={name}
              unit={unit}
              correcting={!outstanding}
              initial={!outstanding ? (t?.measurement ?? "") : ""}
              onRecord={async (text) => {
                const problem = (await tc?.record(setting.id, text)) ?? null;
                if (!problem) setCorrecting(false);
                return problem;
              }}
              onCancel={!outstanding ? () => setCorrecting(false) : undefined}
            />
          ) : (
            <div className="flex items-center gap-2">
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
          )}
        </div>
      ) : (
        <p
          className={cn("shrink-0 font-display text-2xl font-bold tabular-nums", value === "" && !outstanding && "text-muted")}
          data-testid="qt-value"
        >
          {outstanding ? formatTurns(t.cumulative) : formatValue(value || null, methods === "turns" ? null : unit)}
        </p>
      )}
    </div>
  );
}

/**
 * The setting's status on the active Trail (Migration 12): turns shown instead
 * of a measurement, a documented measurement, and the reminders.
 */
function TurnsStatus({ turns, unit, photoUploads }: { turns: TrailTurns | undefined; unit: string | null; photoUploads: boolean }) {
  if (!turns) return null;
  const outstanding = turnsOutstanding(turns);
  const photo = photoUploads && turns.photoNeeded;
  if (!outstanding && turns.measurement === null && !turns.measurementNeeded && !photo) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="qt-turns-status">
      {outstanding ? (
        <span className="font-semibold text-foreground" data-testid="qt-cumulative">
          {formatTurns(turns.cumulative)}
          <span className="font-normal text-muted"> · measurement blank</span>
        </span>
      ) : turns.measurement !== null && turns.cumulative !== null ? (
        <span className="text-muted" data-testid="qt-measured">
          Measured {formatValue(turns.measurement, unit)} after {formatTurns(turns.cumulative)}
        </span>
      ) : null}
      {turns.measurementNeeded ? <ReminderChip kind="measurement" /> : null}
      {photo ? <ReminderChip kind="photo" /> : null}
    </div>
  );
}

/** A signed turns adjustment: − / + by half a turn, or typed (two decimals). */
function TurnsInput({
  name,
  value,
  invalid,
  onChange,
}: {
  name: string;
  value: string;
  invalid: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="qt-turns">
      <button
        type="button"
        onClick={() => onChange(stepTurns(value, -1))}
        aria-label={`Loosen ${name} half a turn`}
        className="grid size-14 shrink-0 place-items-center rounded-xl bg-white/10 text-foreground ring-1 ring-white/15 hover:bg-white/15 active:bg-white/20"
      >
        <Minus aria-hidden className="size-6" />
      </button>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Turns for ${name}`}
        aria-invalid={invalid || undefined}
        data-allow-negative="true"
        maxLength={12}
        className={cn(
          "h-14 w-24 rounded-xl border bg-background/60 px-2 text-center font-display text-2xl font-bold tabular-nums text-foreground placeholder:text-muted focus:outline focus:outline-2 focus:outline-accent",
          invalid ? "border-accent" : value.trim() ? "border-accent/60" : "border-white/15",
        )}
      />
      <button
        type="button"
        onClick={() => onChange(stepTurns(value, 1))}
        aria-label={`Tighten ${name} half a turn`}
        className="grid size-14 shrink-0 place-items-center rounded-xl bg-white/10 text-foreground ring-1 ring-white/15 hover:bg-white/15 active:bg-white/20"
      >
        <Plus aria-hidden className="size-6" />
      </button>
      <span className="w-14 shrink-0 text-sm text-muted">turns</span>
    </div>
  );
}

/** Document the actual measurement on the active Trail (no new Trail), in the row itself. */
function RecordInput({
  name,
  unit,
  correcting,
  initial,
  onRecord,
  onCancel,
}: {
  name: string;
  unit: string | null;
  correcting: boolean;
  initial: string;
  onRecord: (value: string) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const result = await onRecord(text);
    setBusy(false);
    if (result) setProblem(result);
    else setText("");
  };
  return (
    <div className="flex flex-col items-end gap-1" data-testid="qt-record">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && !busy) void submit();
          }}
          aria-label={`Measured ${name}`}
          data-allow-negative="true"
          maxLength={200}
          placeholder="Measured"
          className="h-14 w-28 rounded-xl border border-white/15 bg-background/60 px-2 text-center font-display text-2xl font-bold tabular-nums text-foreground placeholder:text-base placeholder:font-normal placeholder:text-muted focus:outline focus:outline-2 focus:outline-accent"
        />
        {unit ? <span className="text-sm text-muted">{unit}</span> : null}
        <Button type="button" className="h-14" disabled={busy || !text.trim()} onClick={() => void submit()}>
          {busy ? "Saving…" : correcting ? "Save Correction" : "Record Measurement"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" className="h-14" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p className="text-sm text-accent-hot" role="alert">
          {problem}
        </p>
      ) : (
        <p className="text-xs text-muted">Updates this Trail; no new Trail is saved.</p>
      )}
    </div>
  );
}

/** A configuration's values with changes applied (null clears a value). */
function applyChanges(values: Snapshot, changes: Record<string, string | null>, settings: SuspensionSetting[]): Snapshot {
  const result: Snapshot = { ...values };
  for (const [id, value] of Object.entries(changes)) {
    const setting = settings.find((s) => s.id === id);
    if (!setting) continue;
    if (value === null) delete result[id];
    else result[id] = { value, name: setting.name, zone: setting.zone, unit: setting.unit, type: setting.valueType };
  }
  return result;
}

/**
 * The turns status the next Trail will have (shown until the refresh arrives,
 * and used to match earlier Trails): turned settings add up (restarting after a
 * documented measurement); outstanding turns carry; documented ones are values now.
 */
function nextTurns(
  current: TrailTurnsMap,
  turns: Record<string, number>,
  changes: Record<string, string | null>,
  settings: SuspensionSetting[],
): TrailTurnsMap {
  const next: TrailTurnsMap = {};
  for (const [id, t] of Object.entries(current)) {
    if (id in turns || id in changes || !turnsOutstanding(t)) continue;
    next[id] = { ...t, adjustment: null, records: [], measuredAt: null };
  }
  for (const [id, amount] of Object.entries(turns)) {
    const before = current[id];
    const cumulative = turnsOutstanding(before) ? Math.round((before.cumulative + amount) * 100) / 100 : amount;
    next[id] = {
      cumulative,
      measurement: null,
      measuredAt: null,
      measurementNeeded: settings.find((s) => s.id === id)?.inputMethods === "both",
      photoNeeded: settings.find((s) => s.id === id)?.inputMethods === "both",
      adjustment: amount,
      records: [],
    };
  }
  return next;
}
