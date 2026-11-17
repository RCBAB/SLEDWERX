"use client";

import { Wrench, X } from "lucide-react";
import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { createService, type ServiceActionState } from "@/app/garage/service-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { RangeReading } from "@/lib/service/meter-range";
import type { TaskOption } from "@/lib/service/queries";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import { randomUuid } from "@/lib/uuid";

import { ServiceMeterFields, useServiceMeters } from "./mileage";

type Props = {
  sledId: string;
  taskOptions: TaskOption[];
  readings: RangeReading[];
  current: { odometer: number | null; engineHours: number | null };
};

/** "Log service": a quick entry in a few taps, or a link to the full form. */
export function QuickService(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A fresh form (and duplicate-protection key) each time it opens.
  const [session, setSession] = useState(0);

  return (
    <>
      <Button
        type="button"
        size="lg"
        onClick={() => {
          setSession((n) => n + 1);
          dialog.current?.showModal();
        }}
      >
        <Wrench aria-hidden className="size-4" />
        Log service
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="quick-service-title"
        className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-white/10 bg-surface p-0 text-foreground backdrop:bg-black/70 sm:m-auto sm:max-w-lg sm:rounded-2xl"
      >
        {session > 0 ? <QuickServiceForm key={session} {...props} onDone={() => dialog.current?.close()} /> : null}
      </dialog>
    </>
  );
}

function QuickServiceForm({ sledId, taskOptions, readings, current, onDone }: Props & { onDone: () => void }) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const meters = useServiceMeters({ today, current, prefillToday: true });
  const [title, setTitle] = useState("");
  const [task, setTask] = useState<TaskOption | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const [state, formAction] = useActionState<ServiceActionState, FormData>(async (prev, formData) => {
    idempotencyKey.current ??= randomUuid();
    formData.set("idempotencyKey", idempotencyKey.current);
    const result = await createService(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const chips = taskOptions.slice(0, 8);

  return (
    <form action={formAction} className="space-y-5 p-5 sm:p-6" noValidate>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="quick-service-title" className="font-display text-2xl font-bold uppercase italic">
            Quick service
          </h2>
          <p className="text-sm text-muted">Log it now. You can add parts and costs later.</p>
        </div>
        <button type="button" onClick={onDone} className="p-2 text-muted hover:text-foreground" aria-label="Close">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <input
        type="hidden"
        name="tasks"
        value={JSON.stringify(task && task.name === title ? [{ taskId: task.id, name: task.name }] : [])}
      />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}

      {chips.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Your tasks">
          {chips.map((option) => {
            const selected = task?.id === option.id && title === option.name;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setTask(option);
                  setTitle(option.name);
                }}
                className={
                  selected
                    ? "rounded-full border border-accent bg-accent/20 px-3 py-1.5 text-sm font-semibold"
                    : "rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
                }
              >
                {option.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <Field
        label="What did you do?"
        name="title"
        required
        maxLength={200}
        placeholder="e.g. Oil change"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={errors.title?.[0]}
      />
      <ServiceMeterFields meters={meters} readings={readings} errors={errors} today={today} />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href={`/garage/${sledId}/service/new`}
          className="text-center text-sm font-semibold text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          Add details (parts, costs, notes)
        </Link>
        <div className="sm:w-44">
          <SubmitButton pendingText="Saving…">Save service</SubmitButton>
        </div>
      </div>
    </form>
  );
}
