"use client";

import { useActionState, useRef, useState } from "react";

import { completeTasks, type BoardActionState } from "@/app/garage/board-actions";
import { ServiceMeterFields, useServiceMeters } from "@/components/service/mileage";
import { Alert } from "@/components/ui/alert";
import { CheckboxField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { RangeReading } from "@/lib/service/meter-range";
import type { MaintenancePackage, TaskOption } from "@/lib/service/queries";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import { randomUuid } from "@/lib/uuid";

/**
 * Marking tasks done, shared by the sled's Maintenance Board and the Garage
 * Board. Both save through the same completeTasks action, so a completion is
 * always one ordinary service record.
 */

/** What completing tasks on one sled needs. */
export type CompletionContext = {
  sledId: string;
  taskOptions: TaskOption[];
  packages: MaintenancePackage[];
  readings: RangeReading[];
  current: { odometer: number | null; engineHours: number | null };
};

export type TaskRef = { taskId?: string; name: string };

export const TONE_BAR = {
  red: "bg-red-500",
  yellow: "bg-amber-400",
  green: "bg-emerald-500",
  neutral: "bg-white/20",
} as const;

export const TONE_TEXT = {
  red: "text-red-300",
  yellow: "text-amber-300",
  green: "text-emerald-300",
  neutral: "text-muted",
} as const;

/** Date, mileage and hours for a completion (today and the current meters by default). */
export function CompleteForm({
  sledId,
  tasks,
  title,
  readings,
  current,
  onDone,
}: CompletionContext & { tasks: TaskRef[]; title?: string; onDone: () => void }) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const meters = useServiceMeters({ today, current, prefillToday: true });
  const key = useRef<string | null>(null);
  const [state, action] = useActionState<BoardActionState, FormData>(async (prev, formData) => {
    key.current ??= randomUuid();
    formData.set("idempotencyKey", key.current);
    const result = await completeTasks(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <input type="hidden" name="tasks" value={JSON.stringify(tasks)} />
      {title ? <input type="hidden" name="title" value={title} /> : null}
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      {errors.tasks ? <Alert tone="error">{errors.tasks[0]}</Alert> : null}
      {tasks.length > 1 ? (
        <ul className="list-inside list-disc text-sm text-foreground/90" data-testid="done-tasks">
          {tasks.map((t) => (
            <li key={t.taskId ?? t.name}>{t.name}</li>
          ))}
        </ul>
      ) : null}
      <ServiceMeterFields meters={meters} readings={readings} errors={errors} today={today} />
      <SubmitButton pendingText="Saving…">Save</SubmitButton>
    </form>
  );
}

/** Pick a package, tick the tasks you did, then save like Mark Done. */
export function PackageForm(props: CompletionContext & { onDone: () => void }) {
  const { packages } = props;
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const pkg = packages.find((p) => p.id === packageId);
  const [unticked, setUnticked] = useState<string[]>([]);
  const ticked = (pkg?.items ?? []).filter((i) => !unticked.includes(i.taskId));
  const linkable = new Set(props.taskOptions.map((o) => o.id));
  const someNotLinked = ticked.some((i) => !linkable.has(i.taskId));

  return (
    <div className="space-y-5">
      <SelectField
        label="Package"
        name="package"
        value={packageId}
        onChange={(event) => {
          setPackageId(event.target.value);
          setUnticked([]);
        }}
      >
        {packages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      {pkg?.items.length ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-foreground/90">Tasks done</legend>
          {pkg.items.map((item) => (
            <CheckboxField
              key={item.id}
              label={item.name}
              name={`task-${item.taskId}`}
              checked={!unticked.includes(item.taskId)}
              onChange={(event) =>
                setUnticked((ids) => (event.target.checked ? ids.filter((i) => i !== item.taskId) : [...ids, item.taskId]))
              }
            />
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-muted">This package has no tasks yet.</p>
      )}
      {someNotLinked ? (
        <p className="text-sm text-muted">
          Some of these tasks aren&apos;t on this snowmobile&apos;s task list, so they&apos;ll be saved by name and won&apos;t update the board.
        </p>
      ) : null}
      {ticked.length ? (
        <CompleteForm
          key={`${packageId}-${ticked.length}`}
          {...props}
          title={pkg?.name}
          tasks={ticked.map((i) => ({ taskId: i.taskId, name: i.name }))}
        />
      ) : null}
    </div>
  );
}
