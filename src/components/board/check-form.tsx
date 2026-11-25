"use client";

import { CheckCheck, MessageSquarePlus } from "lucide-react";
import { useActionState, useRef, useState } from "react";

import { recordChecks, type BoardActionState } from "@/app/garage/board-actions";
import { ServiceMeterFields, useServiceMeters } from "@/components/service/mileage";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import type { CheckItem } from "@/lib/board/tracking";
import type { InspectStatus } from "@/lib/board/types";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import { randomUuid } from "@/lib/uuid";

import type { CompletionContext } from "./complete-form";
import { Segmented, type SegmentOption } from "./segmented";

type Choice = "good" | "needs_replacement" | "skip";

const STATUS_HINT: Partial<Record<InspectStatus, string>> = {
  overdue: "Overdue",
  due: "Due: mileage updated",
  initial_check: "Initial check needed",
  upcoming: "Due soon",
};

const OPTIONS: SegmentOption<Choice>[] = [
  { value: "good", label: "Good", selectedClass: "bg-emerald-600 text-white ring-emerald-400" },
  { value: "needs_replacement", label: "Needs Replacement", selectedClass: "bg-red-600 text-white ring-red-400" },
  { value: "skip", label: "Skip", selectedClass: "bg-white/20 text-foreground ring-white/40" },
];

/**
 * Checked (one item) and Quick Check (every outstanding inspection on a
 * sled). Date and mileage are filled in and editable, each item gets Good or
 * Needs Replacement (or Skip in Quick Check, which leaves it outstanding), and
 * everything is saved as one Inspection service record.
 */
export function CheckForm({
  sledId,
  items,
  single,
  readings,
  current,
  big,
  onDone,
}: Pick<CompletionContext, "sledId" | "readings" | "current"> & {
  items: CheckItem[];
  /** Checked on one item: no Skip, no Mark All as Good. */
  single?: boolean;
  big?: boolean;
  onDone: () => void;
}) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const meters = useServiceMeters({ today, current, prefillToday: true });
  const key = useRef<string | null>(null);
  // Decision F: due inspections start unanswered, those due soon on Skip.
  const [choices, setChoices] = useState<Record<string, Choice | null>>(() =>
    Object.fromEntries(items.map((i) => [i.taskId, single || i.due ? null : "skip"])),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noting, setNoting] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [nothingToSave, setNothingToSave] = useState(false);
  const [state, action] = useActionState<BoardActionState, FormData>(async (prev, formData) => {
    key.current ??= randomUuid();
    formData.set("idempotencyKey", key.current);
    const result = await recordChecks(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};

  const checks = items.flatMap((i) => {
    const choice = choices[i.taskId];
    if (choice !== "good" && choice !== "needs_replacement") return [];
    const note = notes[i.taskId]?.trim();
    return [{ taskId: i.taskId, outcome: choice, ...(note ? { note } : {}) }];
  });
  const choose = (taskId: string, choice: Choice) => {
    setChoices((c) => ({ ...c, [taskId]: choice }));
    setMissing((m) => m.filter((id) => id !== taskId));
    setNothingToSave(false);
  };
  const markAllGood = () => {
    setChoices((c) => Object.fromEntries(Object.entries(c).map(([id, choice]) => [id, choice === "skip" ? "skip" : "good"])));
    setMissing([]);
  };
  const allSkipped = !checks.length && items.every((i) => choices[i.taskId] === "skip");

  return (
    <form
      action={action}
      className="space-y-5"
      noValidate
      data-testid="check-form"
      onSubmit={(event) => {
        const unanswered = items.filter((i) => choices[i.taskId] == null).map((i) => i.taskId);
        if (unanswered.length || allSkipped) {
          event.preventDefault();
          setMissing(unanswered);
          setNothingToSave(!unanswered.length);
        }
      }}
    >
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <input type="hidden" name="checks" value={JSON.stringify(checks)} />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      {errors.checks ? <Alert tone="error">{errors.checks[0]}</Alert> : null}
      <ServiceMeterFields meters={meters} readings={readings} errors={errors} today={today} />

      {!single && items.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">Skipped items stay outstanding.</p>
          <Button type="button" variant="secondary" size={big ? "lg" : "md"} className={cn(big && "h-14")} onClick={markAllGood}>
            <CheckCheck aria-hidden className="size-4" />
            Mark All as Good
          </Button>
        </div>
      ) : null}

      <ul className="space-y-3" data-testid="check-items">
        {items.map((item) => {
          const unanswered = missing.includes(item.taskId);
          return (
            <li
              key={item.taskId}
              data-testid="check-item"
              className={cn("space-y-2 rounded-xl border bg-background/40 p-3", unanswered ? "border-accent" : "border-white/10")}
            >
              {single ? null : (
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={cn("font-semibold", big && "text-lg")}>{item.name}</span>
                  {STATUS_HINT[item.status] ? <span className="text-xs text-muted">{STATUS_HINT[item.status]}</span> : null}
                </p>
              )}
              <Segmented
                legend={single ? "Result" : `Result for ${item.name}`}
                legendHidden={!single}
                name={`outcome-${item.taskId}`}
                value={choices[item.taskId]}
                options={single ? OPTIONS.slice(0, 2) : OPTIONS}
                onChange={(choice) => choose(item.taskId, choice)}
                big={big}
                error={unanswered ? (single ? "Choose Good or Needs Replacement." : "Choose Good, Needs Replacement or Skip.") : undefined}
              />
              {single ? null : noting.includes(item.taskId) ? (
                <Field
                  label={`Note for ${item.name} (optional)`}
                  name={`note-${item.taskId}`}
                  maxLength={2_000}
                  value={notes[item.taskId] ?? ""}
                  onChange={(event) => setNotes((n) => ({ ...n, [item.taskId]: event.target.value }))}
                />
              ) : (
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted hover:text-foreground"
                  onClick={() => setNoting((n) => [...n, item.taskId])}
                >
                  <MessageSquarePlus aria-hidden className="size-4" />
                  Add a note
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {nothingToSave ? (
        <Alert tone="error">
          Every item is set to Skip. Choose Good or Needs Replacement for at least one, or close this to check later.
        </Alert>
      ) : null}

      <TextareaField
        label="Notes (optional)"
        name="notes"
        rows={single ? 3 : 2}
        maxLength={10_000}
        defaultValue={state.values?.notes ?? ""}
        error={errors.notes?.[0]}
        hint="Saved with this inspection record."
      />
      <FormActions>
        <SubmitButton pendingText="Saving…">
          {single ? "Save check" : `Save checks${checks.length ? ` (${checks.length})` : ""}`}
        </SubmitButton>
      </FormActions>
    </form>
  );
}
