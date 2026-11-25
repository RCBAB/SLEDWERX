"use client";

import { useState } from "react";

import type { BoardActionState } from "@/app/garage/board-actions";
import { CheckboxField, Field, SelectField } from "@/components/ui/field";
import { daysToInterval } from "@/lib/board/describe";
import type { BoardRow, SeasonKind, TrackingMode } from "@/lib/board/types";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { useLocalToday } from "@/lib/sleds/use-local-today";

import { Segmented, type SegmentOption } from "./segmented";

/**
 * The schedule of a board item (Add to board and Schedule): what's tracked,
 * the check schedule and the replacement schedule (each: miles, hours, every
 * N days / weeks / months, once a season), and each one's starting point.
 * A replacement-only item shows only its replacement schedule, as before.
 */

type Part = {
  mi: string;
  hours: string;
  every: string;
  unit: string;
  seasonal: boolean;
  seasonKind: SeasonKind;
  month: string;
  day: string;
  eachReading: boolean;
  asNeeded: boolean;
};
type StartKind = "known" | "tracking" | "unknown";
type Start = { kind: StartKind; on: string; mi: string; hours: string };
type Meters = { odometer: number | null; engineHours: number | null };

/** Decision B: the season presets (dates editable). */
const PRESETS: Record<Exclude<SeasonKind, "season">, { month: string; day: string }> = {
  preseason: { month: "12", day: "1" },
  postseason: { month: "4", day: "15" },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const text = (v: number | string | null | undefined) => (v == null ? "" : String(v));

type Names = {
  mi: string;
  hours: string;
  every: string;
  unit: string;
  seasonal: string;
  seasonKind: string;
  month: string;
  day: string;
  start: string;
  on: string;
  startMi: string;
  startHours: string;
};
const REPLACE: Names = {
  mi: "intervalMi",
  hours: "intervalHours",
  every: "intervalEvery",
  unit: "intervalUnit",
  seasonal: "seasonal",
  seasonKind: "seasonKind",
  month: "seasonMonth",
  day: "seasonDay",
  start: "replaceStart",
  on: "baselineOn",
  startMi: "baselineMi",
  startHours: "baselineHours",
};
const INSPECT: Names = {
  mi: "inspectMi",
  hours: "inspectHours",
  every: "inspectEvery",
  unit: "inspectUnit",
  seasonal: "inspectSeasonal",
  seasonKind: "inspectSeasonKind",
  month: "inspectSeasonMonth",
  day: "inspectSeasonDay",
  start: "inspectStart",
  on: "inspectBaselineOn",
  startMi: "inspectBaselineMi",
  startHours: "inspectBaselineHours",
};

function partFromValues(v: Record<string, string | undefined>, n: Names, extra: { eachReading?: string; asNeeded?: string }): Part {
  const seasonal = v[n.seasonal] === "on";
  return {
    mi: v[n.mi] ?? "",
    hours: v[n.hours] ?? "",
    every: v[n.every] ?? "",
    unit: v[n.unit] ?? "months",
    seasonal,
    seasonKind: (v[n.seasonKind] as SeasonKind) || "preseason",
    month: v[n.month] ?? PRESETS.preseason.month,
    day: v[n.day] ?? PRESETS.preseason.day,
    eachReading: extra.eachReading ? v[extra.eachReading] === "on" : false,
    asNeeded: extra.asNeeded ? v[extra.asNeeded] === "on" : false,
  };
}

function partFrom(schedule: {
  intervalMi: number | null;
  intervalHours: number | null;
  intervalDays: number | null;
  seasonMonth: number | null;
  seasonDay: number | null;
  seasonKind: SeasonKind | null;
  eachReading?: boolean;
  asNeeded?: boolean;
}): Part {
  const every = schedule.intervalDays != null ? daysToInterval(schedule.intervalDays) : null;
  const seasonal = schedule.seasonMonth != null;
  return {
    mi: text(schedule.intervalMi),
    hours: text(schedule.intervalHours),
    every: text(every?.every),
    unit: every?.unit ?? "months",
    seasonal,
    // An existing season date without a label keeps its own date ("every season").
    seasonKind: seasonal ? (schedule.seasonKind ?? "season") : "preseason",
    month: seasonal ? text(schedule.seasonMonth) : PRESETS.preseason.month,
    day: seasonal ? text(schedule.seasonDay) : PRESETS.preseason.day,
    eachReading: Boolean(schedule.eachReading),
    asNeeded: Boolean(schedule.asNeeded),
  };
}

function startFrom(kind: "known" | "tracking" | null, on: string | null, mi: number | null, hours: number | null): Start {
  const known = on != null || mi != null || hours != null;
  return { kind: kind === "tracking" && known ? "tracking" : known ? "known" : "unknown", on: on ?? "", mi: text(mi), hours: text(hours) };
}

const isEmpty = (p: Part) => !p.mi.trim() && !p.hours.trim() && !p.every.trim() && !p.seasonal && !p.eachReading;

export function ScheduleFields({ row, state, current }: { row?: BoardRow; state: BoardActionState; current: Meters }) {
  const v = state.values;
  const t = row?.tracking ?? null;
  const [tracks, setTracks] = useState<TrackingMode>(() => (v?.tracks as TrackingMode) || t?.tracks || "replacement");
  const [replace, setReplace] = useState<Part>(() =>
    v
      ? partFromValues(v, REPLACE, { asNeeded: "replaceAsNeeded" })
      : partFrom({
          intervalMi: row?.intervalMi ?? null,
          intervalHours: row?.intervalHours ?? null,
          intervalDays: row?.intervalDays ?? null,
          seasonMonth: row?.seasonMonth ?? null,
          seasonDay: row?.seasonDay ?? null,
          seasonKind: t?.seasonKind ?? null,
          asNeeded: t?.replaceAsNeeded,
        }),
  );
  const [inspect, setInspect] = useState<Part>(() =>
    v
      ? partFromValues(v, INSPECT, { eachReading: "inspectEachReading" })
      : partFrom(t ? { ...t.inspect, eachReading: t.inspect.eachReading } : EMPTY),
  );
  const [replaceStart, setReplaceStart] = useState<Start>(() =>
    v
      ? { kind: (v.replaceStart as StartKind) || "known", on: v.baselineOn ?? "", mi: v.baselineMi ?? "", hours: v.baselineHours ?? "" }
      : startFrom(t?.replaceBaselineKind ?? null, row?.baselineOn ?? null, row?.baselineMi ?? null, row?.baselineHours ?? null),
  );
  const [inspectStart, setInspectStart] = useState<Start>(() =>
    v
      ? {
          kind: (v.inspectStart as StartKind) || "unknown",
          on: v.inspectBaselineOn ?? "",
          mi: v.inspectBaselineMi ?? "",
          hours: v.inspectBaselineHours ?? "",
        }
      : startFrom(
          t?.inspect.baselineKind ?? null,
          t?.inspect.baselineOn ?? null,
          t?.inspect.baselineMi ?? null,
          t?.inspect.baselineHours ?? null,
        ),
  );
  const errors = state.fieldErrors ?? {};

  // Decision D: converting moves the schedule (and its starting point) across,
  // so nothing has to be typed again and no history is lost.
  const changeTracks = (next: TrackingMode) => {
    if (next === "inspection" && tracks !== "inspection" && isEmpty(inspect)) {
      setInspect({ ...replace, eachReading: false, asNeeded: false });
      if (inspectStart.kind === "unknown") setInspectStart(replaceStart);
    }
    if (next === "replacement" && tracks === "inspection" && isEmpty(replace)) {
      setReplace({ ...inspect, eachReading: false, asNeeded: false });
      if (replaceStart.kind === "unknown") setReplaceStart(inspectStart);
    }
    setTracks(next);
  };

  return (
    <div className="space-y-5">
      <Segmented<TrackingMode>
        legend="What's tracked"
        name="tracks"
        value={tracks}
        onChange={changeTracks}
        options={[
          { value: "replacement", label: "Replacement only" },
          { value: "inspection", label: "Inspection only" },
          { value: "both", label: "Both" },
        ]}
        hint={
          tracks === "replacement"
            ? "Marked Done when it's done, as usual."
            : tracks === "inspection"
              ? "Checked on a schedule. A check of Needs Replacement flags it until it's replaced."
              : "Checked and replaced on separate schedules. Replaced resets both."
        }
      />

      {tracks !== "replacement" ? (
        <ScheduleSection title="Check schedule" testId="check-schedule">
          <ScheduleConditions part={inspect} onChange={setInspect} names={INSPECT} errors={errors} kind="check" />
          <StartingPoint
            start={inspectStart}
            onChange={setInspectStart}
            names={INSPECT}
            errors={errors}
            current={current}
            knownLabel="Last checked"
            unknownHint="An initial check is asked for."
          />
        </ScheduleSection>
      ) : null}

      {tracks !== "inspection" ? (
        <ScheduleSection title={tracks === "both" ? "Replacement schedule" : undefined} testId="replacement-schedule">
          {tracks === "both" ? (
            <CheckboxField
              label="Replace as needed"
              name="replaceAsNeeded"
              checked={replace.asNeeded}
              onChange={(event) => setReplace((p) => ({ ...p, asNeeded: event.target.checked }))}
              hint="No replacement schedule: replace it when a check says so."
            />
          ) : null}
          {replace.asNeeded && tracks === "both" ? null : (
            <ScheduleConditions part={replace} onChange={setReplace} names={REPLACE} errors={errors} kind="replace" />
          )}
          {tracks === "replacement" ? (
            <DoneBefore start={replaceStart} onChange={setReplaceStart} errors={errors} />
          ) : (
            <StartingPoint
              start={replaceStart}
              onChange={setReplaceStart}
              names={REPLACE}
              errors={errors}
              current={current}
              knownLabel="Last replaced"
              unknownHint="Counts from the first replacement."
            />
          )}
        </ScheduleSection>
      ) : null}

      {row ? (
        <CheckboxField
          label="Paused"
          name="paused"
          defaultChecked={v ? v.paused === "on" : row.paused}
          hint="Kept on the board, but never shown as due."
        />
      ) : null}
    </div>
  );
}

const EMPTY = { intervalMi: null, intervalHours: null, intervalDays: null, seasonMonth: null, seasonDay: null, seasonKind: null };

function ScheduleSection({ title, testId, children }: { title?: string; testId: string; children: React.ReactNode }) {
  if (!title)
    return (
      <div className="space-y-4" data-testid={testId}>
        {children}
      </div>
    );
  return (
    <fieldset className="space-y-4 rounded-xl border border-white/10 p-3 sm:p-4" data-testid={testId}>
      <legend className="px-1 font-display text-lg font-bold uppercase italic">{title}</legend>
      {children}
    </fieldset>
  );
}

function ScheduleConditions({
  part,
  onChange,
  names,
  errors,
  kind,
}: {
  part: Part;
  onChange: (update: (p: Part) => Part) => void;
  names: Names;
  errors: Partial<Record<string, string[]>>;
  kind: "check" | "replace";
}) {
  const set = (change: Partial<Part>) => onChange((p) => ({ ...p, ...change }));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Fill in any you want. Whichever comes first is when it&apos;s due.{" "}
        {kind === "replace" ? "Leave all empty to keep it on the board without a schedule." : null}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Every … miles"
          name={names.mi}
          inputMode="decimal"
          value={part.mi}
          onChange={(e) => set({ mi: e.target.value })}
          error={errors[names.mi]?.[0]}
        />
        <Field
          label="Every … engine hours"
          name={names.hours}
          inputMode="decimal"
          value={part.hours}
          onChange={(e) => set({ hours: e.target.value })}
          error={errors[names.hours]?.[0]}
        />
        <Field
          label="Every …"
          name={names.every}
          inputMode="numeric"
          value={part.every}
          onChange={(e) => set({ every: e.target.value })}
          error={errors[names.every]?.[0]}
        />
        <SelectField label="Days, weeks or months" name={names.unit} value={part.unit} onChange={(e) => set({ unit: e.target.value })}>
          <option value="days">Days</option>
          <option value="weeks">Weeks</option>
          <option value="months">Months</option>
        </SelectField>
      </div>
      <CheckboxField
        label="Once a season"
        name={names.seasonal}
        checked={part.seasonal}
        onChange={(event) => set({ seasonal: event.target.checked })}
        hint="Seasons run July to June. Due by a date each season."
      />
      {part.seasonal ? (
        <div className="space-y-3">
          <Segmented<SeasonKind>
            legend="Which"
            legendHidden
            name={names.seasonKind}
            value={part.seasonKind}
            onChange={(seasonKind) => set(seasonKind === "season" ? { seasonKind } : { seasonKind, ...PRESETS[seasonKind] })}
            options={SEASON_OPTIONS}
          />
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="Due by month" name={names.month} value={part.month} onChange={(e) => set({ month: e.target.value })}>
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </SelectField>
            <Field
              label="Day"
              name={names.day}
              inputMode="numeric"
              value={part.day}
              onChange={(e) => set({ day: e.target.value })}
              error={errors[names.day]?.[0]}
            />
          </div>
        </div>
      ) : null}
      {kind === "check" ? (
        <CheckboxField
          label="Every mileage update"
          name="inspectEachReading"
          checked={part.eachReading}
          onChange={(event) => set({ eachReading: event.target.checked })}
          hint="Due again whenever a newer mileage is entered."
        />
      ) : null}
    </div>
  );
}

/**
 * A replacement-only item's starting point, exactly as before: "Done before
 * SledWerx?" with an optional date, miles and hours (empty: no record yet).
 */
function DoneBefore({
  start,
  onChange,
  errors,
}: {
  start: Start;
  onChange: (update: (s: Start) => Start) => void;
  errors: Partial<Record<string, string[]>>;
}) {
  const today = useLocalToday();
  const shown = start.kind === "unknown" ? { on: "", mi: "", hours: "" } : start;
  // Opened once when it has something in it; then the user opens and closes it.
  const [initiallyOpen] = useState(Boolean(shown.on || shown.mi || shown.hours || errors.baselineOn));
  const set = (change: Partial<Start>) =>
    onChange((s) => ({
      ...(s.kind === "unknown" ? { on: "", mi: "", hours: "" } : s),
      kind: s.kind === "tracking" ? "tracking" : "known",
      ...change,
    }));
  return (
    <details className="rounded-xl border border-white/10 p-3 text-sm" open={initiallyOpen}>
      <summary className="cursor-pointer font-medium">Done before SledWerx?</summary>
      <input type="hidden" name="replaceStart" value={start.kind === "tracking" ? "tracking" : "known"} />
      <p className="mt-2 text-muted">If you did it before you started using SledWerx, add when, so the schedule can count from there.</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field
          label="Date"
          name="baselineOn"
          type="date"
          max={today || undefined}
          value={shown.on}
          onChange={(e) => set({ on: e.target.value })}
          error={errors.baselineOn?.[0]}
          className="col-span-2 sm:col-span-1"
        />
        <Field
          label="Miles then"
          name="baselineMi"
          inputMode="decimal"
          value={shown.mi}
          onChange={(e) => set({ mi: e.target.value })}
          error={errors.baselineMi?.[0]}
        />
        <Field
          label="Hours then"
          name="baselineHours"
          inputMode="decimal"
          value={shown.hours}
          onChange={(e) => set({ hours: e.target.value })}
          error={errors.baselineHours?.[0]}
        />
      </div>
    </details>
  );
}

const SEASON_OPTIONS: SegmentOption<SeasonKind>[] = [
  { value: "preseason", label: "Preseason" },
  { value: "postseason", label: "Postseason" },
  { value: "season", label: "Every season" },
];

function StartingPoint({
  start,
  onChange,
  names,
  errors,
  current,
  knownLabel,
  unknownHint,
}: {
  start: Start;
  onChange: (update: (s: Start) => Start) => void;
  names: Names;
  errors: Partial<Record<string, string[]>>;
  current: Meters;
  knownLabel: string;
  unknownHint: string;
}) {
  const today = useLocalToday();
  const set = (change: Partial<Start>) => onChange((s) => ({ ...s, ...change }));
  const at = [start.mi ? formatMiles(Number(start.mi)) : null, start.hours ? formatHours(Number(start.hours)) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="space-y-3 rounded-xl bg-black/20 p-3">
      <Segmented<StartKind>
        legend="Starting point"
        name={names.start}
        value={start.kind}
        onChange={(kind) =>
          // A new tracking start counts from today; an existing one keeps its date.
          set(
            kind === "tracking" && start.kind !== "tracking"
              ? { kind, on: today, mi: text(current.odometer), hours: text(current.engineHours) }
              : { kind },
          )
        }
        options={[
          { value: "known", label: "Known" },
          { value: "tracking", label: "Start tracking now" },
          { value: "unknown", label: "Unknown" },
        ]}
        error={errors[names.on]?.[0] && start.kind === "tracking" ? errors[names.on]?.[0] : undefined}
      />
      {start.kind === "known" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field
            label={`${knownLabel}: date`}
            name={names.on}
            type="date"
            max={today || undefined}
            value={start.on}
            onChange={(e) => set({ on: e.target.value })}
            error={errors[names.on]?.[0]}
            className="col-span-2 sm:col-span-1"
          />
          <Field
            label="Miles then"
            name={names.startMi}
            inputMode="decimal"
            value={start.mi}
            onChange={(e) => set({ mi: e.target.value })}
            error={errors[names.startMi]?.[0]}
          />
          <Field
            label="Hours then"
            name={names.startHours}
            inputMode="decimal"
            value={start.hours}
            onChange={(e) => set({ hours: e.target.value })}
            error={errors[names.startHours]?.[0]}
          />
        </div>
      ) : start.kind === "tracking" ? (
        <>
          <input type="hidden" name={names.on} value={start.on || today} />
          <input type="hidden" name={names.startMi} value={start.mi} />
          <input type="hidden" name={names.startHours} value={start.hours} />
          <p className="text-sm text-muted" data-testid="tracking-start">
            Counts from {!start.on || start.on === today ? "today" : formatDate(start.on)}
            {at ? ` at ${at}` : ""}. Nothing is recorded as done.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted">{unknownHint}</p>
      )}
    </div>
  );
}
