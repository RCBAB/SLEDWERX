"use client";

import { Check, CheckSquare, ListChecks, Plus, Settings2, Square } from "lucide-react";
import { useActionState, useLayoutEffect, useState } from "react";

import { addToBoard, removeFromBoard, saveSchedule, type BoardActionState } from "@/app/garage/board-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CheckboxField, Field, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { STATUS_LABEL, STATUS_TONE, daysToInterval, lastDoneLine, scheduleSummary, statusLine } from "@/lib/board/describe";
import type { BoardRow } from "@/lib/board/types";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";

import { CompleteForm, PackageForm, TONE_BAR, TONE_TEXT, type CompletionContext, type TaskRef } from "./complete-form";
import { Sheet } from "./sheet";
import { useRefreshOnReturn } from "./use-refresh-on-return";

type Props = CompletionContext & {
  rows: BoardRow[];
  canManage: boolean;
  canComplete: boolean;
};

type OpenSheet =
  | { kind: "done"; tasks: TaskRef[]; title?: string; choose?: boolean }
  | { kind: "schedule"; row: BoardRow }
  | { kind: "add" }
  | { kind: "package" }
  | null;

export function MaintenanceBoard(props: Props) {
  const { rows, canManage, canComplete, packages } = props;
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const open = (next: OpenSheet) => {
    setSession((n) => n + 1);
    setSheet(next);
  };
  const close = () => setSheet(null);
  // Next.js keeps a page hidden (not unmounted) after navigating away; close
  // any open sheet then, so it isn't still open on return.
  useLayoutEffect(() => () => setSheet(null), []);
  useRefreshOnReturn();
  const toggle = (planId: string) =>
    setSelected((ids) => (ids.includes(planId) ? ids.filter((i) => i !== planId) : [...ids, planId]));
  const selectedRows = rows.filter((r) => selected.includes(r.planId));

  return (
    <section className="mt-8" aria-labelledby="board-heading" data-testid="maintenance-board">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="board-heading" className="font-display text-3xl font-extrabold uppercase italic tracking-tight">
          Maintenance board
        </h2>
        <div className="flex flex-wrap gap-2">
          {canComplete && rows.length ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setSelecting((s) => !s);
                setSelected([]);
              }}
            >
              <ListChecks aria-hidden className="size-4" />
              {selecting ? "Cancel" : "Select"}
            </Button>
          ) : null}
          {canComplete && packages.length && !selecting ? (
            <Button type="button" variant="secondary" onClick={() => open({ kind: "package" })}>
              Complete package
            </Button>
          ) : null}
          {canManage && !selecting ? (
            <Button type="button" variant="secondary" onClick={() => open({ kind: "add" })}>
              <Plus aria-hidden className="size-4" />
              Add to board
            </Button>
          ) : null}
        </div>
      </div>

      {rows.length ? (
        <ul className="mt-4 space-y-2" data-testid="board-rows">
          {rows.map((row) => {
            const tone = STATUS_TONE[row.status];
            const isSelected = selected.includes(row.planId);
            return (
              <li
                key={row.planId}
                data-testid="board-row"
                data-status={row.status}
                className={cn(
                  "flex items-stretch overflow-hidden rounded-2xl border bg-surface/70",
                  isSelected ? "border-accent" : "border-white/10",
                )}
              >
                <span aria-hidden className={cn("w-1.5 shrink-0", TONE_BAR[tone])} />
                <div className="flex min-w-0 flex-1 items-center gap-3 p-3 sm:p-4">
                  {selecting ? (
                    <button
                      type="button"
                      onClick={() => toggle(row.planId)}
                      aria-pressed={isSelected}
                      aria-label={`Select ${row.taskName}`}
                      className="p-1 text-muted hover:text-foreground"
                    >
                      {isSelected ? <CheckSquare aria-hidden className="size-6 text-accent" /> : <Square aria-hidden className="size-6" />}
                    </button>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="break-words font-semibold">{row.taskName}</span>
                      <span className="sr-only">{STATUS_LABEL[row.status]}:</span>
                    </p>
                    <p className={cn("text-sm font-semibold", TONE_TEXT[tone])} data-testid="board-status">
                      {statusLine(row)}
                    </p>
                    <p className="text-xs text-muted" data-testid="board-last-done">
                      {lastDoneLine(row)}
                    </p>
                    <p className="text-xs text-muted/80">{scheduleSummary(row)}</p>
                  </div>
                  {!selecting ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => open({ kind: "schedule", row })}
                          className="p-2 text-muted hover:text-foreground"
                          aria-label={`Schedule for ${row.taskName}`}
                        >
                          <Settings2 aria-hidden className="size-5" />
                        </button>
                      ) : null}
                      {canComplete ? (
                        <Button
                          type="button"
                          className="h-11 px-4"
                          aria-label={`Mark ${row.taskName} done`}
                          onClick={() => open({ kind: "done", tasks: [{ taskId: row.taskId, name: row.taskName }] })}
                        >
                          <Check aria-hidden className="size-4" />
                          Done
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-surface/40 px-5 py-8 text-center">
          <p className="font-semibold">Nothing on the board yet</p>
          <p className="mt-1 text-sm text-muted">
            {canManage
              ? "Add the maintenance you want to keep track of, like oil, belts or a preseason check."
              : "The owner hasn't added any maintenance to track yet."}
          </p>
          {canManage ? (
            <Button type="button" className="mt-4" onClick={() => open({ kind: "add" })}>
              <Plus aria-hidden className="size-4" />
              Add to board
            </Button>
          ) : null}
        </div>
      )}

      {selecting ? (
        <div className="sticky bottom-20 z-10 mt-3 flex justify-end lg:bottom-4">
          <Button
            type="button"
            size="lg"
            disabled={!selectedRows.length}
            onClick={() =>
              open({ kind: "done", tasks: selectedRows.map((r) => ({ taskId: r.taskId, name: r.taskName })) })
            }
          >
            <Check aria-hidden className="size-4" />
            Done ({selectedRows.length})
          </Button>
        </div>
      ) : null}

      <Sheet
        open={sheet?.kind === "done"}
        onClose={close}
        title={sheet?.kind === "done" && sheet.tasks.length === 1 ? sheet.tasks[0].name : "Mark done"}
        description="Saves a service record and updates the board."
      >
        {sheet?.kind === "done" ? (
          <CompleteForm
            key={session}
            {...props}
            tasks={sheet.tasks}
            title={sheet.title}
            onDone={() => {
              close();
              setSelecting(false);
              setSelected([]);
            }}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "package"} onClose={close} title="Complete package" description="Tick what you did.">
        {sheet?.kind === "package" ? <PackageForm key={session} {...props} onDone={close} /> : null}
      </Sheet>

      <Sheet open={sheet?.kind === "schedule"} onClose={close} title={sheet?.kind === "schedule" ? sheet.row.taskName : "Schedule"}>
        {sheet?.kind === "schedule" ? <ScheduleForm key={session} sledId={props.sledId} row={sheet.row} onDone={close} /> : null}
      </Sheet>

      <Sheet open={sheet?.kind === "add"} onClose={close} title="Add to board">
        {sheet?.kind === "add" ? <AddForm key={session} {...props} onDone={close} /> : null}
      </Sheet>
    </section>
  );
}

/** Schedule fields shared by Add to board and Schedule. */
function ScheduleFields({ row, state }: { row?: BoardRow; state: BoardActionState }) {
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const every = row?.intervalDays != null ? daysToInterval(row.intervalDays) : null;
  const [seasonal, setSeasonal] = useState(v ? v.seasonal === "on" : row?.seasonMonth != null);
  const value = (key: string, fallback: number | string | null | undefined) => (v ? (v[key] ?? "") : fallback == null ? "" : String(fallback));
  const today = useLocalToday();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Fill in any you want. Whichever comes first is when it&apos;s due. Leave all empty to keep it on the board without a schedule.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Every … miles" name="intervalMi" inputMode="decimal" defaultValue={value("intervalMi", row?.intervalMi)} error={errors.intervalMi?.[0]} />
        <Field label="Every … engine hours" name="intervalHours" inputMode="decimal" defaultValue={value("intervalHours", row?.intervalHours)} error={errors.intervalHours?.[0]} />
        <Field label="Every …" name="intervalEvery" inputMode="numeric" defaultValue={value("intervalEvery", every?.every)} error={errors.intervalEvery?.[0]} />
        <SelectField label="Days, weeks or months" name="intervalUnit" defaultValue={value("intervalUnit", every?.unit ?? "months")}>
          <option value="days">Days</option>
          <option value="weeks">Weeks</option>
          <option value="months">Months</option>
        </SelectField>
      </div>
      <CheckboxField
        label="Once a season"
        name="seasonal"
        checked={seasonal}
        onChange={(event) => setSeasonal(event.target.checked)}
        hint="Seasons run July to June. Due by a date each season, like a preseason check by Nov 1."
      />
      {seasonal ? (
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Due by month" name="seasonMonth" defaultValue={value("seasonMonth", row?.seasonMonth ?? 11)}>
            {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
              (month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ),
            )}
          </SelectField>
          <Field label="Day" name="seasonDay" inputMode="numeric" defaultValue={value("seasonDay", row?.seasonDay ?? 1)} error={errors.seasonDay?.[0]} />
        </div>
      ) : null}
      <details className="rounded-xl border border-white/10 p-3 text-sm" open={Boolean(row?.baselineOn || row?.baselineMi || errors.baselineOn)}>
        <summary className="cursor-pointer font-medium">Done before SledWerx?</summary>
        <p className="mt-2 text-muted">If you did it before you started using SledWerx, add when, so the schedule can count from there.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Date" name="baselineOn" type="date" max={today || undefined} defaultValue={value("baselineOn", row?.baselineOn)} error={errors.baselineOn?.[0]} className="col-span-2 sm:col-span-1" />
          <Field label="Miles then" name="baselineMi" inputMode="decimal" defaultValue={value("baselineMi", row?.baselineMi)} error={errors.baselineMi?.[0]} />
          <Field label="Hours then" name="baselineHours" inputMode="decimal" defaultValue={value("baselineHours", row?.baselineHours)} error={errors.baselineHours?.[0]} />
        </div>
      </details>
      {row ? <CheckboxField label="Paused" name="paused" defaultChecked={v ? v.paused === "on" : row.paused} hint="Kept on the board, but never shown as due." /> : null}
    </div>
  );
}

function ScheduleForm({ sledId, row, onDone }: { sledId: string; row: BoardRow; onDone: () => void }) {
  const timeZone = useTimeZone();
  const [state, action] = useActionState<BoardActionState, FormData>(async (prev, formData) => {
    const result = await saveSchedule(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const [removeState, removeAction, removing] = useActionState<BoardActionState, FormData>(async (prev, formData) => {
    const result = await removeFromBoard(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-5" noValidate key={state.values ? JSON.stringify(state.values) : "form"}>
        <input type="hidden" name="sledId" value={sledId} />
        <input type="hidden" name="planId" value={row.planId} />
        <input type="hidden" name="version" value={row.version} />
        <input type="hidden" name="timeZone" value={timeZone} />
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <ScheduleFields row={row} state={state} />
        <SubmitButton pendingText="Saving…">Save schedule</SubmitButton>
      </form>
      <form
        action={removeAction}
        onSubmit={(event) => {
          if (!window.confirm(`Remove “${row.taskName}” from the board? Its service history is kept.`)) event.preventDefault();
        }}
      >
        <input type="hidden" name="sledId" value={sledId} />
        <input type="hidden" name="planId" value={row.planId} />
        <input type="hidden" name="version" value={row.version} />
        {removeState.error ? <p className="mb-2 text-sm text-accent-hot">{removeState.error}</p> : null}
        <Button type="submit" variant="ghost" className="w-full" disabled={removing}>
          Remove from board
        </Button>
      </form>
    </div>
  );
}

function AddForm({ sledId, rows, taskOptions, onDone }: Props & { onDone: () => void }) {
  const timeZone = useTimeZone();
  const onBoard = new Set(rows.map((r) => r.taskId));
  const available = taskOptions.filter((o) => !onBoard.has(o.id));
  const [state, action] = useActionState<BoardActionState, FormData>(async (prev, formData) => {
    const result = await addToBoard(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};

  return (
    <form action={action} className="space-y-5" noValidate key={state.values ? JSON.stringify(state.values) : "form"}>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {available.length ? (
        <SelectField label="Task" name="taskId" defaultValue={state.values?.taskId ?? ""} error={errors.taskId?.[0]}>
          <option value="">Choose a task, or type a new one below…</option>
          {available.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.scope === "sled" ? " (this snowmobile)" : ""}
            </option>
          ))}
        </SelectField>
      ) : null}
      <Field
        label="New task"
        name="newTaskName"
        maxLength={120}
        placeholder="e.g. Change chaincase oil"
        defaultValue={state.values?.newTaskName ?? ""}
        error={errors.newTaskName?.[0] ?? (available.length ? undefined : errors.taskId?.[0])}
      />
      <ScheduleFields state={state} />
      <SubmitButton pendingText="Adding…">Add to board</SubmitButton>
    </form>
  );
}
