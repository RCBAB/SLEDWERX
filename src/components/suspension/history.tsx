"use client";

import {
  Camera,
  GitCompareArrows,
  History,
  MessageSquarePlus,
  Minus,
  Pencil,
  RotateCcw,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useActionState, useState } from "react";

import { deleteFeedback, saveFeedback, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate, formatHours, formatMiles } from "@/lib/sleds/format";
import { canEditSuspensionFeedback, suspensionCapabilities } from "@/lib/sleds/permissions";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";
import { describeChange, revisionChanges } from "@/lib/suspension/diff";
import {
  FEEDBACK_LABEL,
  FEEDBACK_RATINGS,
  ZONE_LABEL,
  previousRevision,
  type FeedbackRating,
  type SuspensionFeedback,
  type SuspensionRevision,
  type SuspensionSetting,
} from "@/lib/suspension/types";

import { PhotoGrid } from "./photos";
import { LocalDate, RatingBadge, useRun } from "./shared";

/** How many revisions show before "Show more". */
const PAGE = 10;
/** How many changes of one revision show before "Show all". */
const CHANGES_SHOWN = 5;

/**
 * The selected setup's revisions, newest first: what changed (against the
 * revision before it), who saved it and when, the copied mileage and hours,
 * restore links, the note and every feedback entry. Nothing here can be
 * edited except feedback; earlier revisions are restored by saving a new one.
 */
export function RevisionHistory({
  revisions,
  allRevisions,
  settings,
  role,
  userId,
  onAddFeedback,
  onEditFeedback,
  onCompare,
  onRestore,
  onPhotos,
}: {
  /** This setup's revisions, newest first. */
  revisions: SuspensionRevision[];
  /** Every revision on the sled (for "restored from" numbers). */
  allRevisions: SuspensionRevision[];
  settings: SuspensionSetting[];
  role: SledRole;
  userId: string;
  onAddFeedback: (revision: SuspensionRevision) => void;
  onEditFeedback: (revision: SuspensionRevision, feedback: SuspensionFeedback) => void;
  onCompare: (revision: SuspensionRevision) => void;
  onRestore: (revision: SuspensionRevision) => void;
  onPhotos: (revision: SuspensionRevision) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const latestId = revisions[0]?.id;
  if (!revisions.length) return <p className="text-muted">No revisions yet.</p>;
  return (
    <div className="space-y-3">
      <ol className="space-y-3" data-testid="revision-history">
        {revisions.slice(0, shown).map((revision) => (
          <RevisionCard
            key={revision.id}
            revision={revision}
            previous={previousRevision(allRevisions, revision)}
            current={revision.id === latestId}
            settings={settings}
            role={role}
            userId={userId}
            onAddFeedback={() => onAddFeedback(revision)}
            onEditFeedback={(feedback) => onEditFeedback(revision, feedback)}
            onCompare={() => onCompare(revision)}
            onRestore={() => onRestore(revision)}
            onPhotos={() => onPhotos(revision)}
          />
        ))}
      </ol>
      {revisions.length > shown ? (
        <Button type="button" variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, revisions.length - shown)} more ({revisions.length - shown} older)
        </Button>
      ) : null}
    </div>
  );
}

function RevisionCard({
  revision,
  previous,
  current,
  settings,
  role,
  userId,
  onAddFeedback,
  onEditFeedback,
  onCompare,
  onRestore,
  onPhotos,
}: {
  revision: SuspensionRevision;
  previous: SuspensionRevision | undefined;
  current: boolean;
  settings: SuspensionSetting[];
  role: SledRole;
  userId: string;
  onAddFeedback: () => void;
  onEditFeedback: (feedback: SuspensionFeedback) => void;
  onCompare: () => void;
  onRestore: () => void;
  onPhotos: () => void;
}) {
  const can = suspensionCapabilities(role);
  const changes = revisionChanges(previous?.values ?? null, revision.values, settings);
  const { busy, error, run } = useRun();
  const [allChanges, setAllChanges] = useState(false);
  return (
    <li
      className={cn("rounded-2xl border bg-surface/70 p-4 sm:p-5", current ? "border-accent/50" : "border-white/10")}
      data-testid="revision"
      data-number={revision.number}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-2xl font-bold uppercase italic leading-none">Rev {revision.number}</h3>
            {current ? (
              <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[0.7rem] font-bold uppercase tracking-wider text-accent-hot ring-1 ring-accent/50">
                Current
              </span>
            ) : null}
            {revision.restoredFrom ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs font-semibold text-foreground/90 ring-1 ring-white/15"
                data-testid="restored-from"
              >
                <History aria-hidden className="size-3.5" />
                Restored from rev {revision.restoredFrom.number || "?"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted" data-testid="revision-meta">
            <LocalDate value={revision.createdAt} withTime /> · {revision.createdByName}
            {revision.odometer != null ? ` · ${formatMiles(revision.odometer)}` : ""}
            {revision.engineHours != null ? ` · ${formatHours(revision.engineHours)}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 text-sm" data-testid="revision-changes">
        {previous ? (
          changes.length ? (
            <ul className="space-y-1">
              {(allChanges ? changes : changes.slice(0, CHANGES_SHOWN)).map((change) => (
                <li key={change.settingId} className="flex flex-wrap gap-x-2">
                  <span className="text-muted">{ZONE_LABEL[change.zone]}</span>
                  <span className={cn("font-medium", change.kind === "cleared" ? "text-muted" : "text-foreground")}>
                    {describeChange(change)}
                  </span>
                </li>
              ))}
              {changes.length > CHANGES_SHOWN ? (
                <li>
                  <button
                    type="button"
                    className="min-h-11 text-sm font-semibold text-accent-hot underline-offset-4 hover:underline"
                    aria-expanded={allChanges}
                    onClick={() => setAllChanges((open) => !open)}
                  >
                    {allChanges ? "Show fewer" : `Show all ${changes.length} changes`}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-muted">Same values as rev {previous.number}.</p>
          )
        ) : changes.length ? (
          <p className="text-muted">
            Started with {changes.length} value{changes.length === 1 ? "" : "s"}.
          </p>
        ) : (
          <p className="text-muted">Started blank.</p>
        )}
      </div>

      {revision.note ? (
        <p
          className="mt-3 whitespace-pre-line break-words rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-foreground/90"
          data-testid="revision-note"
        >
          {revision.note}
        </p>
      ) : null}

      {revision.photos.length ? (
        <div className="mt-3" data-testid="revision-photos">
          <PhotoGrid photos={revision.photos} label={`rev ${revision.number}`} canRemove={false} size="sm" />
        </div>
      ) : null}

      {revision.feedback.length ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Ride feedback</p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <ul className="space-y-2" data-testid="feedback-list">
            {revision.feedback.map((feedback) => {
              const canEdit = canEditSuspensionFeedback(role, feedback.createdBy, userId);
              return (
                <li key={feedback.id} className="rounded-xl border border-white/10 bg-background/40 px-3 py-2" data-testid="feedback">
                  <div className="flex items-center gap-x-3">
                    <RatingBadge rating={feedback.rating} />
                    <p className="min-w-0 flex-1 text-sm text-muted">
                      <span className="whitespace-nowrap">Ridden {formatDate(feedback.riddenOn)}</span>{" "}
                      <span className="whitespace-nowrap">· {feedback.createdByName}</span>
                    </p>
                    {canEdit || can.canRemove ? (
                      <div className="-my-1 flex shrink-0 gap-1">
                        {canEdit ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="size-11 p-0"
                            disabled={busy}
                            aria-label={`Edit feedback from ${formatDate(feedback.riddenOn)}`}
                            onClick={() => onEditFeedback(feedback)}
                          >
                            <Pencil aria-hidden className="size-4" />
                          </Button>
                        ) : null}
                        {can.canRemove ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="size-11 p-0"
                            disabled={busy}
                            aria-label={`Remove feedback from ${formatDate(feedback.riddenOn)}`}
                            onClick={() => {
                              if (window.confirm("Remove this feedback? It can be restored from Recently Deleted for 30 days."))
                                void run(() => deleteFeedback(feedback.id, feedback.version));
                            }}
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {feedback.note ? (
                    <p className="mt-1 whitespace-pre-line break-words text-sm text-foreground/90" data-testid="feedback-note">
                      {feedback.note}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3">
        {can.canAddFeedback ? (
          <Button type="button" variant="secondary" onClick={onAddFeedback} aria-label={`Add ride feedback to rev ${revision.number}`}>
            <MessageSquarePlus aria-hidden className="size-4" />
            Add feedback
          </Button>
        ) : null}
        {can.canAddAdjustmentPhotos || revision.photos.length ? (
          <Button type="button" variant="ghost" onClick={onPhotos} aria-label={`Photos of rev ${revision.number}`}>
            <Camera aria-hidden className="size-4" />
            Photos{revision.photos.length ? ` (${revision.photos.length})` : ""}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCompare} aria-label={`Compare rev ${revision.number}`}>
          <GitCompareArrows aria-hidden className="size-4" />
          Compare
        </Button>
        {can.canAdjust && !current ? (
          <Button type="button" variant="ghost" onClick={onRestore} aria-label={`Restore rev ${revision.number}`}>
            <RotateCcw aria-hidden className="size-4" />
            Restore this revision
          </Button>
        ) : null}
      </div>
    </li>
  );
}

const RATING_ICON: Record<FeedbackRating, typeof TrendingUp> = { improved: TrendingUp, worse: TrendingDown, no_change: Minus };
const RATING_CHOICE: Record<FeedbackRating, string> = {
  improved: "bg-emerald-500/15 text-emerald-100 ring-emerald-400/70",
  worse: "bg-red-500/15 text-red-100 ring-red-400/70",
  no_change: "bg-white/10 text-foreground ring-white/40",
};

/** Add ride feedback to a revision, or edit an entry. */
export function FeedbackForm({
  sledId,
  revision,
  feedback,
  onDone,
}: {
  sledId: string;
  revision: SuspensionRevision;
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
  const [rating, setRating] = useState<FeedbackRating | null>((v?.rating as FeedbackRating) ?? feedback?.rating ?? null);

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {feedback ? (
        <>
          <input type="hidden" name="feedbackId" value={feedback.id} />
          <input type="hidden" name="version" value={feedback.version} />
        </>
      ) : (
        <input type="hidden" name="revisionId" value={revision.id} />
      )}
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-foreground/90">How did it ride?</legend>
        <div className="grid grid-cols-3 gap-2">
          {FEEDBACK_RATINGS.map((value) => {
            const Icon = RATING_ICON[value];
            return (
              <label
                key={value}
                className={cn(
                  "flex min-h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-sm font-bold ring-1",
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
                <Icon aria-hidden className="size-5" />
                {FEEDBACK_LABEL[value]}
              </label>
            );
          })}
        </div>
        {errors.rating?.[0] ? <p className="mt-1 text-sm text-accent-hot">{errors.rating[0]}</p> : null}
      </fieldset>
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
      <TextareaField
        label="Notes (optional)"
        name="note"
        maxLength={2000}
        placeholder="Conditions, how it felt, what to try next…"
        defaultValue={v?.note ?? feedback?.note ?? ""}
        error={errors.note?.[0]}
      />
      <FormActions>
        <SubmitButton pendingText="Saving…">{feedback ? "Save changes" : "Save feedback"}</SubmitButton>
      </FormActions>
    </form>
  );
}
