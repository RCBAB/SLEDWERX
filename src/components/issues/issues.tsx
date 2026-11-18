"use client";

import { AlertTriangle, Camera, CheckCircle2, ChevronDown, Pencil, Plus, RotateCcw, Trash2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  addIssuePhoto,
  deleteIssue,
  loadResolvableServices,
  removeIssuePhoto,
  reopenIssue,
  resolveIssue,
  saveIssue,
  type IssueActionState,
} from "@/app/garage/issue-actions";
import { Sheet } from "@/components/board/sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ServiceOption } from "@/lib/issues/queries";
import { PhotoError, uploadIssuePhoto } from "@/lib/issues/photo-upload";
import { MAX_ISSUE_PHOTOS, PRIORITIES, PRIORITY_LABEL, type Issue, type IssuePriority } from "@/lib/issues/types";
import type { SledRole } from "@/lib/sleds/constants";
import { formatDate, formatMiles } from "@/lib/sleds/format";
import { serviceCapabilities } from "@/lib/sleds/permissions";
import { useLocalToday, useTimeZone } from "@/lib/sleds/use-local-today";

/**
 * The issue log for one sled: open issues, a collapsed history of resolved
 * ones, and sheets to report, view, edit, resolve, reopen and delete. Used on
 * the sled page and on the Garage Board (Cards, Compact and Wall Display).
 * Every change goes through the issue server actions, as the signed-in user.
 */

export const PRIORITY_STYLE: Record<IssuePriority, string> = {
  critical: "bg-red-500/20 text-red-200 ring-red-500/60",
  high: "bg-orange-500/15 text-orange-200 ring-orange-500/50",
  medium: "bg-amber-400/10 text-amber-200 ring-amber-400/40",
  low: "bg-white/5 text-muted ring-white/15",
};

type Props = {
  sledId: string;
  sledName: string;
  issues: Issue[];
  role: SledRole;
  userId: string;
  currentOdometer: number | null;
  /** Sled page: full list and history. Board: up to 3 open issues and a count. */
  variant: "page" | "board";
  big?: boolean;
};

type OpenSheet =
  | { kind: "report" }
  | { kind: "detail"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "resolve"; id: string }
  | { kind: "all" }
  | null;

const BOARD_LIMIT = 3;

export function SledIssues(props: Props) {
  const { sledId, sledName, issues, role, userId, variant, big = false } = props;
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  // Close sheets when the page is hidden (Next.js keeps it mounted).
  useLayoutEffect(() => () => setSheet(null), []);

  const open = issues.filter((i) => i.status === "open");
  const resolved = issues.filter((i) => i.status === "resolved");
  const canReport = role !== "viewer";
  const show = (next: OpenSheet) => {
    setSession((n) => n + 1);
    setSheet(next);
  };
  const close = () => setSheet(null);
  const current = sheet && "id" in sheet ? issues.find((i) => i.id === sheet.id) : undefined;
  const shown = variant === "board" ? open.slice(0, BOARD_LIMIT) : open;
  const more = open.length - shown.length;

  const list = (items: Issue[]) => (
    <ul className="space-y-2" data-testid={variant === "page" ? "open-issues" : "board-issues"}>
      {items.map((issue) => (
        <IssueRow key={issue.id} issue={issue} big={big} onOpen={() => show({ kind: "detail", id: issue.id })} />
      ))}
    </ul>
  );

  return (
    <div data-testid="sled-issues" data-sled-id={sledId}>
      {variant === "page" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="issues-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
            Issues
          </h2>
          {canReport ? (
            <Button type="button" variant="secondary" onClick={() => show({ kind: "report" })} aria-label={`Report issue on ${sledName}`}>
              <Plus aria-hidden className="size-4" />
              Report issue
            </Button>
          ) : null}
        </div>
      ) : null}

      {open.length ? (
        <div className={cn(variant === "page" && "mt-4")}>{list(shown)}</div>
      ) : variant === "page" ? (
        <p className="mt-4 text-muted">No open issues.</p>
      ) : null}

      {variant === "board" && (more > 0 || canReport) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {more > 0 ? (
            <Button type="button" variant="ghost" size={big ? "lg" : "md"} className={cn(big && "h-14")} onClick={() => show({ kind: "all" })}>
              and {more} more open issue{more === 1 ? "" : "s"}
            </Button>
          ) : null}
          {canReport ? (
            <Button
              type="button"
              variant="secondary"
              size={big ? "lg" : "md"}
              className={cn(big && "h-14")}
              aria-label={`Report issue on ${sledName}`}
              onClick={() => show({ kind: "report" })}
            >
              <AlertTriangle aria-hidden className="size-4" />
              Report issue
            </Button>
          ) : null}
        </div>
      ) : null}

      {variant === "page" && resolved.length ? (
        <div className="mt-4">
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm font-semibold text-muted hover:text-foreground"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((s) => !s)}
          >
            <ChevronDown aria-hidden className={cn("size-4 transition-transform", showHistory && "rotate-180")} />
            Resolved issues ({resolved.length})
          </button>
          {showHistory ? (
            <ul className="mt-3 space-y-2" data-testid="resolved-issues">
              {resolved.map((issue) => (
                <IssueRow key={issue.id} issue={issue} big={big} onOpen={() => show({ kind: "detail", id: issue.id })} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Sheet open={sheet?.kind === "all"} onClose={close} title="Open issues" description={sledName}>
        {sheet?.kind === "all" ? list(open) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "report"} onClose={close} title="Report issue" description={sledName}>
        {sheet?.kind === "report" ? <IssueForm key={session} {...props} onDone={close} /> : null}
      </Sheet>

      <Sheet open={sheet?.kind === "edit" && Boolean(current)} onClose={close} title="Edit issue" description={sledName}>
        {sheet?.kind === "edit" && current ? (
          <IssueForm key={session} {...props} issue={current} onDone={() => show({ kind: "detail", id: current.id })} />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "resolve" && Boolean(current)} onClose={close} title="Resolve issue" description={current?.title}>
        {sheet?.kind === "resolve" && current ? (
          <ResolveForm key={session} sledId={sledId} issue={current} onDone={() => show({ kind: "detail", id: current.id })} />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "detail" && Boolean(current)} onClose={close} title={current?.title ?? "Issue"} description={sledName}>
        {sheet?.kind === "detail" && current ? (
          <IssueDetail
            key={`${current.id}-${current.version}`}
            sledId={sledId}
            issue={current}
            role={role}
            userId={userId}
            onEdit={() => show({ kind: "edit", id: current.id })}
            onResolve={() => show({ kind: "resolve", id: current.id })}
            onClosed={close}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

export function PriorityBadge({ priority, className }: { priority: IssuePriority; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ring-1", PRIORITY_STYLE[priority], className)}
      data-testid="issue-priority"
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

function IssueRow({ issue, big, onOpen }: { issue: Issue; big: boolean; onOpen: () => void }) {
  const thumb = issue.photos[0]?.url;
  return (
    <li data-testid="issue-row" data-priority={issue.priority} data-status={issue.status}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View issue ${issue.title}`}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-background/40 p-3 text-left hover:border-white/25",
          big && "min-h-16 p-4",
        )}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={issue.priority} />
            <span className={cn("min-w-0 break-words font-semibold", big && "text-lg")} data-testid="issue-title">
              {issue.title}
            </span>
          </span>
          <span className={cn("mt-0.5 block text-muted", big ? "text-sm" : "text-xs")}>
            {issue.status === "open"
              ? `Reported ${formatDate(issue.reportedOn)}${issue.odometer != null ? ` · ${formatMiles(issue.odometer)}` : ""}`
              : `Resolved ${formatDate(issue.resolvedOn)}${issue.resolvedEntry ? ` · ${issue.resolvedEntry.title}` : ""}`}
            {issue.photos.length ? ` · ${issue.photos.length} photo${issue.photos.length === 1 ? "" : "s"}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function abilities(role: SledRole, issue: Issue, userId: string) {
  const can = serviceCapabilities(role, issue.createdBy, userId);
  return { canEdit: can.canEdit, canDelete: can.canDelete };
}

function IssueDetail({
  sledId,
  issue,
  role,
  userId,
  onEdit,
  onResolve,
  onClosed,
}: {
  sledId: string;
  issue: Issue;
  role: SledRole;
  userId: string;
  onEdit: () => void;
  onResolve: () => void;
  onClosed: () => void;
}) {
  const { canEdit, canDelete } = abilities(role, issue, userId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<IssueActionState>, after?: () => void) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.error) setError(result.error);
    else after?.();
  };

  return (
    <div className="space-y-5" data-testid="issue-detail" data-status={issue.status}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={issue.priority} />
        <span className={cn("text-sm font-semibold", issue.status === "open" ? "text-amber-200" : "text-emerald-300")}>
          {issue.status === "open" ? "Open" : "Resolved"}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-[0.15em] text-muted">Reported</dt>
          <dd>{formatDate(issue.reportedOn)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.15em] text-muted">Mileage</dt>
          <dd>{issue.odometer != null ? formatMiles(issue.odometer) : "Not recorded"}</dd>
        </div>
      </dl>
      {issue.description ? <p className="whitespace-pre-line break-words text-foreground/90">{issue.description}</p> : null}
      {issue.photos.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="issue-photos">
          {issue.photos.map((photo, n) => (
            <li key={photo.id} className="relative">
              {photo.url ? (
                <a href={photo.url} target="_blank" rel="noreferrer" className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.url} alt={`Photo ${n + 1} of ${issue.title}`} className="aspect-square w-full rounded-lg object-cover" />
                </a>
              ) : (
                <div className="grid aspect-square place-items-center rounded-lg bg-white/5 text-xs text-muted">Photo unavailable</div>
              )}
              {canDelete ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Remove this photo? It can be restored from Recently Deleted for 30 days."))
                      void run(() => removeIssuePhoto(photo.id, photo.version));
                  }}
                  aria-label={`Remove photo ${n + 1}`}
                  className="absolute right-1 top-1 grid size-9 place-items-center rounded-full bg-black/70 text-foreground hover:bg-black"
                >
                  <X aria-hidden className="size-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {issue.status === "resolved" ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm" data-testid="issue-resolution">
          <p className="font-semibold text-emerald-200">Resolved {formatDate(issue.resolvedOn)}</p>
          {issue.resolvedEntry ? (
            <p className="mt-1">
              <Wrench aria-hidden className="mr-1 inline size-4" />
              {issue.resolvedEntry.deleted ? (
                "By a service record that was later deleted."
              ) : (
                <>
                  By service:{" "}
                  <Link href={`/garage/${sledId}#service-history`} className="font-semibold underline underline-offset-4">
                    {issue.resolvedEntry.title}
                  </Link>{" "}
                  ({formatDate(issue.resolvedEntry.performedOn)})
                </>
              )}
            </p>
          ) : null}
          {issue.resolutionNotes ? <p className="mt-2 whitespace-pre-line break-words text-foreground/90">{issue.resolutionNotes}</p> : null}
        </div>
      ) : null}

      {canEdit || canDelete ? (
        <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4">
          {canEdit && issue.status === "open" ? (
            <Button type="button" size="lg" onClick={onResolve} disabled={busy}>
              <CheckCircle2 aria-hidden className="size-4" />
              Resolve
            </Button>
          ) : null}
          {canEdit && issue.status === "resolved" ? (
            <Button type="button" variant="secondary" size="lg" disabled={busy} onClick={() => void run(() => reopenIssue(issue.id, issue.version))}>
              <RotateCcw aria-hidden className="size-4" />
              Reopen
            </Button>
          ) : null}
          {canEdit ? (
            <Button type="button" variant="secondary" size="lg" onClick={onEdit} disabled={busy}>
              <Pencil aria-hidden className="size-4" />
              Edit
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete “${issue.title}”? It can be restored from Recently Deleted for 30 days.`))
                  void run(() => deleteIssue(issue.id, issue.version), onClosed);
              }}
            >
              <Trash2 aria-hidden className="size-4" />
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PriorityChoice({ value, onChange, error }: { value: IssuePriority; onChange: (p: IssuePriority) => void; error?: string }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-foreground/90">Priority</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[...PRIORITIES].reverse().map((p) => (
          <label
            key={p}
            className={cn(
              "flex h-12 cursor-pointer items-center justify-center rounded-lg text-sm font-bold uppercase tracking-wide ring-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
              value === p ? PRIORITY_STYLE[p] + " ring-2" : "bg-white/5 text-muted ring-white/10",
            )}
          >
            <input type="radio" name="priority" value={p} checked={value === p} onChange={() => onChange(p)} className="sr-only" />
            {PRIORITY_LABEL[p]}
          </label>
        ))}
      </div>
      {error ? <p className="mt-1 text-sm text-accent-hot">{error}</p> : null}
    </fieldset>
  );
}

/** Report a new issue, or edit one (photos are added after the issue is saved). */
function IssueForm({
  sledId,
  issue,
  currentOdometer,
  onDone,
}: Props & { issue?: Issue; onDone: () => void }) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const [priority, setPriority] = useState<IssuePriority>(issue?.priority ?? "medium");
  const [files, setFiles] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [moreOpened, setMoreOpened] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const existing = issue?.photos.length ?? 0;
  const room = MAX_ISSUE_PHOTOS - existing;

  const [state, action] = useActionState<IssueActionState, FormData>(async (prev, formData) => {
    setPhotoError(null);
    const result = await saveIssue(prev, formData);
    if (!result.ok || !result.issueId) return result;
    // The issue is saved; now its new photos, one by one.
    for (const [n, file] of files.entries()) {
      try {
        const path = await uploadIssuePhoto(sledId, result.issueId, file);
        const added = await addIssuePhoto(sledId, result.issueId, path, existing + n);
        if (added.error) throw new PhotoError(added.error);
      } catch (error) {
        setPhotoError(
          `The issue was saved, but ${error instanceof PhotoError ? error.message.replace(/^A photo/, "a photo") : "a photo couldn't be added"}. You can add photos by editing it.`,
        );
        return { ok: true, issueId: result.issueId, savedAt: Date.now() };
      }
    }
    onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {issue ? (
        <>
          <input type="hidden" name="issueId" value={issue.id} />
          <input type="hidden" name="version" value={issue.version} />
        </>
      ) : null}
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      {photoError ? <Alert tone="error">{photoError}</Alert> : null}
      <Field label="Title" name="title" maxLength={200} autoComplete="off" defaultValue={v?.title ?? issue?.title ?? ""} error={errors.title?.[0]} placeholder="e.g. Track squeaks at low speed" />
      <PriorityChoice value={priority} onChange={setPriority} error={errors.priority?.[0]} />
      <TextareaField label="Description (optional)" name="description" maxLength={10_000} defaultValue={v?.description ?? issue?.description ?? ""} error={errors.description?.[0]} />
      <Field
        label="Mileage (odometer)"
        name="odometer"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={v?.odometer ?? (issue ? (issue.odometer?.toString() ?? "") : (currentOdometer?.toString() ?? ""))}
        hint={issue ? undefined : "The current reading. Change it if the issue started earlier."}
        error={errors.odometer?.[0]}
      />
      <details
        className="rounded-xl border border-white/10 p-3 text-sm"
        open={moreOpened || Boolean(errors.reportedOn)}
        onToggle={(event) => setMoreOpened(event.currentTarget.open)}
      >
        <summary className="cursor-pointer font-medium">More options</summary>
        <div className="mt-3">
          <Field
            key={today}
            label="Date noticed"
            name="reportedOn"
            type="date"
            required
            max={today || undefined}
            defaultValue={v?.reportedOn || issue?.reportedOn || today}
            error={errors.reportedOn?.[0]}
          />
        </div>
      </details>
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground/90">Photos (optional)</p>
        {room > 0 ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label="Add photos"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                setFiles((current) => [...current, ...picked].slice(0, room));
                event.target.value = "";
              }}
            />
            <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} disabled={files.length >= room}>
              <Camera aria-hidden className="size-4" />
              Add photos
            </Button>
            <p className="text-sm text-muted">
              Up to {MAX_ISSUE_PHOTOS} per issue{existing ? ` (${existing} already added)` : ""}.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">This issue already has {MAX_ISSUE_PHOTOS} photos.</p>
        )}
        {files.length ? (
          <ul className="flex flex-wrap gap-2" data-testid="new-issue-photos">
            {files.map((file, n) => (
              <PendingPhoto key={`${file.name}-${n}`} file={file} onRemove={() => setFiles((list) => list.filter((_, i) => i !== n))} />
            ))}
          </ul>
        ) : null}
      </div>
      <FormActions>
        <SubmitButton pendingText="Saving…">{issue ? "Save changes" : "Save issue"}</SubmitButton>
      </FormActions>
    </form>
  );
}

function PendingPhoto({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    const timer = window.setTimeout(() => setUrl(objectUrl), 0);
    return () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);
  return (
    <li className="relative">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="size-20 rounded-lg object-cover" />
      ) : (
        <div className="size-20 rounded-lg bg-white/5" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Don't add ${file.name}`}
        className="absolute -right-1 -top-1 grid size-8 place-items-center rounded-full bg-black/80 text-foreground"
      >
        <X aria-hidden className="size-4" />
      </button>
    </li>
  );
}

/** Resolve manually (with optional notes) or by linking a completed service record. */
function ResolveForm({ sledId, issue, onDone }: { sledId: string; issue: Issue; onDone: () => void }) {
  const today = useLocalToday();
  const timeZone = useTimeZone();
  const [how, setHow] = useState<"manual" | "service">("manual");
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [entryId, setEntryId] = useState("");
  const [resolvedOn, setResolvedOn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadResolvableServices(sledId)
      .then((list) => live && setServices(list))
      .catch(() => live && setServices([]));
    return () => {
      live = false;
    };
  }, [sledId]);
  const [state, action] = useActionState<IssueActionState, FormData>(async (prev, formData) => {
    const result = await resolveIssue(prev, formData);
    if (result.ok) onDone();
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const date = resolvedOn ?? today;

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="issueId" value={issue.id} />
      <input type="hidden" name="version" value={issue.version} />
      <input type="hidden" name="timeZone" value={timeZone} />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-foreground/90">How was it resolved?</legend>
        {(
          [
            ["manual", "Fixed or checked (add notes if you like)"],
            ["service", "Fixed by a service record"],
          ] as const
        ).map(([value, text]) => (
          <label key={value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-white/10 px-3 has-[:checked]:border-accent">
            <input type="radio" name="how" value={value} checked={how === value} onChange={() => setHow(value)} className="size-5 accent-[var(--color-accent)]" />
            <span className="text-sm font-medium">{text}</span>
          </label>
        ))}
      </fieldset>
      {how === "service" ? (
        services === null ? (
          <p className="text-sm text-muted">Loading service records…</p>
        ) : services.length ? (
          <SelectField
            label="Service record"
            name="entryId"
            value={entryId}
            error={errors.entryId?.[0]}
            hint="Completed service records on this snowmobile. Nothing is copied: the issue links to it."
            onChange={(event) => {
              setEntryId(event.target.value);
              const picked = services.find((s) => s.id === event.target.value);
              if (picked) setResolvedOn(picked.performedOn > issue.reportedOn ? picked.performedOn : null);
            }}
          >
            <option value="">Choose a service record…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDate(s.performedOn)} · {s.title}
              </option>
            ))}
          </SelectField>
        ) : (
          <p className="text-sm text-muted" data-testid="no-services">
            There are no completed service records on this snowmobile yet. Log the service first, or resolve it manually.
          </p>
        )
      ) : null}
      <Field
        key={`${today}-${date}`}
        label="Resolved on"
        name="resolvedOn"
        type="date"
        required
        min={issue.reportedOn}
        max={today || undefined}
        defaultValue={state.values?.resolvedOn || date}
        error={errors.resolvedOn?.[0]}
      />
      <TextareaField label="Notes (optional)" name="notes" maxLength={10_000} defaultValue={state.values?.notes ?? ""} error={errors.notes?.[0]} />
      <FormActions>
        <SubmitButton pendingText="Saving…">Mark resolved</SubmitButton>
      </FormActions>
    </form>
  );
}
