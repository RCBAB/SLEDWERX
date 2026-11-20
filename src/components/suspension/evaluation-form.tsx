"use client";

import { Meh, ThumbsDown, ThumbsUp } from "lucide-react";
import { useActionState, useState } from "react";

import { saveFeedback, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/components/ui/cn";
import { Field, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import {
  CONDITION_LABEL,
  FEEDBACK_LABEL,
  RIDE_RATINGS,
  TRAIL_CONDITIONS,
  isRideRating,
  isTrailCondition,
  type RideRating,
  type SuspensionFeedback,
  type TrailCondition,
} from "@/lib/suspension/types";

const RATING_ICON: Record<RideRating, typeof ThumbsUp> = { liked: ThumbsUp, neutral: Meh, disliked: ThumbsDown };
const RATING_CHOICE: Record<RideRating, string> = {
  liked: "bg-emerald-500/15 text-emerald-100 ring-emerald-400/70",
  neutral: "bg-amber-400/10 text-amber-50 ring-amber-300/70",
  disliked: "bg-red-500/15 text-red-100 ring-red-400/70",
};

/**
 * Add a ride evaluation to one configuration (several are allowed; none
 * creates a configuration), or edit one: overall rating, any trail
 * conditions, the ride date (today by default), the day's high in °F and notes.
 */
export function EvaluationForm({
  sledId,
  revisionId,
  feedback,
  onDone,
}: {
  sledId: string;
  revisionId: string;
  feedback?: SuspensionFeedback;
  onDone: () => void;
}) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const [state, action] = useActionState<SuspensionActionState, FormData>(async (prev, formData) => {
    const result = await saveFeedback(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const initialRating = v?.rating ?? feedback?.rating;
  const [rating, setRating] = useState<RideRating | null>(isRideRating(initialRating) ? initialRating : null);
  const [conditions, setConditions] = useState<TrailCondition[]>(
    v?.conditions !== undefined ? v.conditions.split(",").filter(isTrailCondition) : (feedback?.conditions ?? []),
  );
  const toggle = (c: TrailCondition) => setConditions((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]));
  const legacy = feedback && !isRideRating(feedback.rating) ? FEEDBACK_LABEL[feedback.rating] : null;

  return (
    <form action={action} className="space-y-5" noValidate data-testid="evaluation-form">
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {feedback ? (
        <>
          <input type="hidden" name="feedbackId" value={feedback.id} />
          <input type="hidden" name="version" value={feedback.version} />
        </>
      ) : (
        <input type="hidden" name="revisionId" value={revisionId} />
      )}
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-foreground/90">Overall rating</legend>
        {legacy ? <p className="mb-2 text-sm text-muted">Saved earlier as “{legacy}”. Choose a rating to save changes.</p> : null}
        <div className="grid grid-cols-3 gap-2">
          {RIDE_RATINGS.map((value) => {
            const Icon = RATING_ICON[value];
            return (
              <label
                key={value}
                className={cn(
                  "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-sm font-bold ring-1",
                  "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  rating === value ? `${RATING_CHOICE[value]} ring-2` : "bg-white/5 text-muted ring-white/10",
                )}
              >
                <input
                  type="radio"
                  name="rating"
                  value={value}
                  checked={rating === value}
                  onChange={() => setRating(value)}
                  className="sr-only"
                />
                <Icon aria-hidden className="size-6" />
                {FEEDBACK_LABEL[value]}
              </label>
            );
          })}
        </div>
        {errors.rating?.[0] ? <p className="mt-1 text-sm text-accent-hot">{errors.rating[0]}</p> : null}
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-foreground/90">Trail conditions (choose any)</legend>
        <div className="flex flex-wrap gap-2">
          {TRAIL_CONDITIONS.map((c) => {
            const on = conditions.includes(c);
            return (
              <label
                key={c}
                className={cn(
                  "inline-flex min-h-12 cursor-pointer items-center rounded-full px-4 text-sm font-semibold ring-1",
                  "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  on ? "bg-sky-400/15 text-sky-50 ring-2 ring-sky-300/70" : "bg-white/5 text-muted ring-white/10",
                )}
              >
                <input type="checkbox" name="conditions" value={c} checked={on} onChange={() => toggle(c)} className="sr-only" />
                {CONDITION_LABEL[c]}
              </label>
            );
          })}
        </div>
        {errors.conditions?.[0] ? <p className="mt-1 text-sm text-accent-hot">{errors.conditions[0]}</p> : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          key={today}
          label="Ride date"
          name="riddenOn"
          type="date"
          required
          max={today || undefined}
          defaultValue={v?.riddenOn || feedback?.riddenOn || today}
          error={errors.riddenOn?.[0]}
        />
        <Field
          label="Day's high °F (optional)"
          name="highTemp"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={v?.highTemp ?? (feedback?.highTempF != null ? String(feedback.highTempF) : "")}
          error={errors.highTemp?.[0]}
        />
      </div>
      <TextareaField
        label="Ride notes (optional)"
        name="note"
        maxLength={2000}
        placeholder="How it felt, what to try next…"
        defaultValue={v?.note ?? feedback?.note ?? ""}
        error={errors.note?.[0]}
      />
      <FormActions>
        <SubmitButton pendingText="Saving…">{feedback ? "Save changes" : "Save evaluation"}</SubmitButton>
      </FormActions>
    </form>
  );
}
