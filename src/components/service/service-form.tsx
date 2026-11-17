"use client";

import { ArrowDown, ArrowUp, ListPlus, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";

import { createService, updateService, type ServiceActionState } from "@/app/garage/service-actions";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { SERVICE_CATEGORIES } from "@/lib/service/constants";
import { formatUsd, partLineTotal, serviceCosts } from "@/lib/service/costs";
import {
  newPartRow,
  newTaskRow,
  parseAmount,
  partsPayload,
  tasksPayload,
  type PartRow,
  type TaskRow,
} from "@/lib/service/form";
import type { RangeReading } from "@/lib/service/meter-range";
import type { MaintenancePackage, ServiceRecord, TaskOption } from "@/lib/service/queries";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import { randomUuid } from "@/lib/uuid";

import { ServiceMeterFields, useServiceMeters } from "./mileage";

type Props = {
  sledId: string;
  record?: ServiceRecord;
  taskOptions: TaskOption[];
  packages: MaintenancePackage[];
  readings: RangeReading[];
  current: { odometer: number | null; engineHours: number | null };
  canRemoveMileage: boolean;
};

const sectionTitle = "mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-muted";

export function ServiceForm({ sledId, record, taskOptions, packages, readings, current, canRemoveMileage }: Props) {
  const router = useRouter();
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const editing = Boolean(record);
  // One key per new record, created on first submit and reused on retries, so
  // a double tap or a retry never saves the service twice.
  const idempotencyKey = useRef<string | null>(null);

  const meters = useServiceMeters({
    today,
    initialDate: record?.performedOn,
    initialOdometer: record?.odometer,
    initialHours: record?.engineHours,
    initialUnknown: editing && !record?.readingId,
    current,
    prefillToday: !editing,
  });

  const [tasks, setTasks] = useState<TaskRow[]>(() =>
    (record?.tasks ?? []).map((t) => ({ key: t.id, id: t.id, taskId: t.taskId ?? undefined, name: t.name })),
  );
  const [parts, setParts] = useState<PartRow[]>(() =>
    (record?.parts ?? []).map((p) => ({
      key: p.id,
      id: p.id,
      name: p.name,
      partNumber: p.partNumber ?? "",
      brand: p.brand ?? "",
      supplier: p.supplier ?? "",
      quantity: String(p.quantity),
      unitCost: p.unitCost == null ? "" : String(p.unitCost),
    })),
  );
  const [labor, setLabor] = useState(record?.laborCost == null ? "" : String(record.laborCost));
  const [other, setOther] = useState(record?.otherCost == null ? "" : String(record.otherCost));
  const [freeTask, setFreeTask] = useState("");

  const [state, formAction] = useActionState<ServiceActionState, FormData>(async (prev, formData) => {
    if (!editing) {
      idempotencyKey.current ??= randomUuid();
      formData.set("idempotencyKey", idempotencyKey.current);
    }
    const result = editing ? await updateService(prev, formData) : await createService(prev, formData);
    if (result.ok) {
      router.push(`/garage/${sledId}?service=${editing ? "updated" : "saved"}#service-history`);
    }
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const value = (key: string, fallback: string | null | undefined) => state.values?.[key] ?? fallback ?? "";

  const costs = serviceCosts({
    parts: parts.map((p) => ({ quantity: parseAmount(p.quantity) ?? 0, unitCost: parseAmount(p.unitCost) })),
    laborCost: parseAmount(labor),
    otherCost: parseAmount(other),
  });

  const hasTask = (taskId?: string, name?: string) =>
    tasks.some((t) => (taskId && t.taskId === taskId) || (name && t.name.toLowerCase() === name.toLowerCase()));

  function addTask(task: { taskId?: string; name: string }) {
    if (!task.name.trim() || hasTask(task.taskId, task.name)) return;
    setTasks((rows) => [...rows, newTaskRow(task)]);
  }

  function applyPackage(packageId: string) {
    const selected = packages.find((p) => p.id === packageId);
    if (!selected) return;
    setTasks((rows) => {
      const next = [...rows];
      for (const item of selected.items) {
        const exists = next.some((t) => t.taskId === item.taskId || t.name.toLowerCase() === item.name.toLowerCase());
        if (!exists) next.push(newTaskRow({ taskId: item.taskId, name: item.name }));
      }
      return next;
    });
  }

  function moveTask(index: number, direction: -1 | 1) {
    setTasks((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const updatePart = (key: string, change: Partial<PartRow>) =>
    setParts((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const unknownDisabledReason =
    editing && record?.readingId && !canRemoveMileage
      ? "Only the owner or an editor can remove the mileage from a record. You can correct it."
      : undefined;

  return (
    // Re-mounted when the server returns values, so text fields show what was typed.
    <form action={formAction} className="space-y-8" noValidate key={state.values ? JSON.stringify(state.values) : "form"}>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <input type="hidden" name="tasks" value={tasksPayload(tasks)} />
      <input type="hidden" name="parts" value={partsPayload(parts)} />
      {record ? (
        <>
          <input type="hidden" name="entryId" value={record.id} />
          <input type="hidden" name="version" value={record.version} />
        </>
      ) : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="space-y-5">
        <legend className={sectionTitle}>Service</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Title"
            name="title"
            required
            maxLength={200}
            placeholder="e.g. Preseason service"
            defaultValue={value("title", record?.title)}
            error={errors.title?.[0]}
            className="sm:col-span-2"
          />
          <SelectField label="Category (optional)" name="category" defaultValue={value("category", record?.category)} error={errors.category?.[0]}>
            <option value="">No category</option>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectField>
          <Field
            label="Done by (optional)"
            name="doneBy"
            maxLength={120}
            placeholder="Me, or a shop's name"
            defaultValue={value("doneBy", record?.doneBy)}
            error={errors.doneBy?.[0]}
          />
        </div>
        <ServiceMeterFields
          meters={meters}
          readings={readings}
          excludeReadingId={record?.readingId}
          errors={errors}
          today={today}
          unknownDisabledReason={unknownDisabledReason}
        />
      </fieldset>

      <fieldset>
        <legend className={sectionTitle}>Work performed</legend>
        {errors.tasks ? <p className="mb-3 text-sm text-accent-hot">{errors.tasks[0]}</p> : null}
        {tasks.length ? (
          <ol className="mb-4 divide-y divide-white/10 rounded-xl border border-white/10" data-testid="service-tasks">
            {tasks.map((task, index) => (
              <li key={task.key} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 text-sm tabular-nums text-muted">{index + 1}.</span>
                {task.taskId ? (
                  <span className="flex-1 text-sm font-medium">{task.name}</span>
                ) : (
                  <input
                    aria-label={`Task ${index + 1}`}
                    value={task.name}
                    maxLength={120}
                    onChange={(event) =>
                      setTasks((rows) => rows.map((r) => (r.key === task.key ? { ...r, name: event.target.value } : r)))
                    }
                    className="h-10 flex-1 rounded-lg border border-white/15 bg-black/30 px-3 text-sm"
                  />
                )}
                <button type="button" className="p-2 text-muted hover:text-foreground disabled:opacity-30" aria-label={`Move ${task.name} up`} disabled={index === 0} onClick={() => moveTask(index, -1)}>
                  <ArrowUp aria-hidden className="size-4" />
                </button>
                <button type="button" className="p-2 text-muted hover:text-foreground disabled:opacity-30" aria-label={`Move ${task.name} down`} disabled={index === tasks.length - 1} onClick={() => moveTask(index, 1)}>
                  <ArrowDown aria-hidden className="size-4" />
                </button>
                <button type="button" className="p-2 text-muted hover:text-accent-hot" aria-label={`Remove task ${task.name}`} onClick={() => setTasks((rows) => rows.filter((r) => r.key !== task.key))}>
                  <Trash2 aria-hidden className="size-4" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mb-4 text-sm text-muted">No tasks yet. Add tasks from your list, type your own, or apply a package.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {taskOptions.length ? (
            <SelectField
              label="Add a task from your list"
              name="taskPicker"
              value=""
              onChange={(event) => {
                const option = taskOptions.find((o) => o.id === event.target.value);
                if (option) addTask({ taskId: option.id, name: option.name });
              }}
            >
              <option value="">Choose a task…</option>
              {taskOptions.map((o) => (
                <option key={o.id} value={o.id} disabled={hasTask(o.id, o.name)}>
                  {o.name}
                  {o.scope === "sled" ? " (this snowmobile)" : ""}
                </option>
              ))}
            </SelectField>
          ) : null}
          {packages.length ? (
            <SelectField
              label="Apply a package"
              name="packagePicker"
              value=""
              onChange={(event) => applyPackage(event.target.value)}
            >
              <option value="">Choose a package…</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.items.length} {p.items.length === 1 ? "task" : "tasks"})
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <div className="mt-4 flex gap-2">
          <Field
            label="Or type a task"
            name="freeTask"
            value={freeTask}
            maxLength={120}
            onChange={(event) => setFreeTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTask({ name: freeTask.trim() });
                setFreeTask("");
              }
            }}
            className="flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            className="mt-7 h-12"
            onClick={() => {
              addTask({ name: freeTask.trim() });
              setFreeTask("");
            }}
          >
            <ListPlus aria-hidden className="size-4" />
            Add task
          </Button>
        </div>
      </fieldset>

      <fieldset>
        <legend className={sectionTitle}>Parts</legend>
        {errors.parts ? <p className="mb-3 text-sm text-accent-hot">{errors.parts[0]}</p> : null}
        <div className="space-y-3" data-testid="service-parts">
          {parts.map((part, index) => (
            <div key={part.key} className="rounded-xl border border-white/10 bg-black/10 p-3" data-testid="part-row">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[2fr_1.3fr_0.7fr_1fr_auto]">
                <Field label="Part" name={`partName${index}`} value={part.name} maxLength={200} onChange={(e) => updatePart(part.key, { name: e.target.value })} className="col-span-2 sm:col-span-1" />
                <Field label="Part number (optional)" name={`partNumber${index}`} value={part.partNumber} maxLength={120} onChange={(e) => updatePart(part.key, { partNumber: e.target.value })} className="col-span-2 sm:col-span-1" />
                <Field label="Qty" name={`partQty${index}`} inputMode="decimal" value={part.quantity} onChange={(e) => updatePart(part.key, { quantity: e.target.value })} />
                <Field label="Unit cost ($)" name={`partCost${index}`} inputMode="decimal" value={part.unitCost} onChange={(e) => updatePart(part.key, { unitCost: e.target.value })} />
                <div className="col-span-2 flex items-end justify-between gap-3 sm:col-span-1 sm:flex-col sm:items-end sm:justify-end">
                  <span className="text-sm tabular-nums text-muted" data-testid="part-line-total">
                    {formatUsd(partLineTotal({ quantity: parseAmount(part.quantity) ?? 0, unitCost: parseAmount(part.unitCost) }))}
                  </span>
                  <button type="button" className="p-2 text-muted hover:text-accent-hot" aria-label={`Remove part ${part.name || index + 1}`} onClick={() => setParts((rows) => rows.filter((r) => r.key !== part.key))}>
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                </div>
              </div>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted hover:text-foreground">Brand and supplier</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Brand (optional)" name={`partBrand${index}`} value={part.brand} maxLength={120} onChange={(e) => updatePart(part.key, { brand: e.target.value })} />
                  <Field label="Supplier (optional)" name={`partSupplier${index}`} value={part.supplier} maxLength={120} onChange={(e) => updatePart(part.key, { supplier: e.target.value })} />
                </div>
              </details>
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" className="mt-3" onClick={() => setParts((rows) => [...rows, newPartRow()])}>
          <Plus aria-hidden className="size-4" />
          Add part
        </Button>
      </fieldset>

      <fieldset>
        <legend className={sectionTitle}>Costs (USD)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Labor (optional)" name="laborCost" inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} error={errors.laborCost?.[0]} />
          <Field label="Other costs (optional)" name="otherCost" inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} hint="Shop supplies, fees, shipping…" error={errors.otherCost?.[0]} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-surface/60 p-4 text-sm sm:grid-cols-4" data-testid="cost-summary">
          <div>
            <dt className="text-muted">Parts</dt>
            <dd className="font-semibold tabular-nums">{formatUsd(costs.parts)}</dd>
          </div>
          <div>
            <dt className="text-muted">Labor</dt>
            <dd className="font-semibold tabular-nums">{formatUsd(costs.labor)}</dd>
          </div>
          <div>
            <dt className="text-muted">Other</dt>
            <dd className="font-semibold tabular-nums">{formatUsd(costs.other)}</dd>
          </div>
          <div>
            <dt className="text-muted">Total</dt>
            <dd className="font-display text-xl font-bold tabular-nums" data-testid="cost-total">
              {formatUsd(costs.total)}
            </dd>
          </div>
        </dl>
      </fieldset>

      <TextareaField label="Notes (optional)" name="notes" maxLength={10000} defaultValue={value("notes", record?.notes)} error={errors.notes?.[0]} />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <ButtonLink href={`/garage/${sledId}#service-history`} variant="secondary" size="lg">
          Cancel
        </ButtonLink>
        <div className="sm:w-56">
          <SubmitButton pendingText="Saving…">{editing ? "Save changes" : "Save service"}</SubmitButton>
        </div>
      </div>
    </form>
  );
}
