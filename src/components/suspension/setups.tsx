"use client";

import { CheckCircle2, Pencil, Plus, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";

import { activateSetup, deleteSetup, saveSetup, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CheckboxField, Field, SelectField, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { latestRevision, type SuspensionRevision, type SuspensionSetup } from "@/lib/suspension/types";

import { ActiveBadge, LocalDate, useRun } from "./shared";

/**
 * The setups of the sled: pick one to view; owners and editors also create,
 * copy, rename, activate and delete. Wraps onto several lines rather than
 * scrolling sideways.
 */
export function SetupBar({
  setups,
  revisions,
  selectedId,
  onSelect,
  canManage,
  onNew,
}: {
  setups: SuspensionSetup[];
  revisions: SuspensionRevision[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Setups" data-testid="setup-bar">
      {setups.map((setup) => {
        const latest = latestRevision(revisions, setup.id);
        const selected = setup.id === selectedId;
        return (
          <button
            key={setup.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(setup.id)}
            data-testid="setup-tab"
            data-active={setup.isActive ? "true" : undefined}
            className={cn(
              "flex min-h-12 min-w-0 max-w-full items-center gap-2 rounded-xl border px-4 py-2 text-left transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              selected ? "border-accent bg-accent/10" : "border-white/10 bg-surface/60 hover:border-white/25",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-semibold">{setup.name}</span>
              <span className="block text-xs text-muted">{latest ? `Rev ${latest.number}` : "No revisions"}</span>
            </span>
            {setup.isActive ? <ActiveBadge /> : null}
          </button>
        );
      })}
      {canManage ? (
        <Button type="button" variant="secondary" className="min-h-12" onClick={onNew}>
          <Plus aria-hidden className="size-4" />
          New setup
        </Button>
      ) : null}
    </div>
  );
}

/** Rename / Set active / Delete for the selected setup (owners and editors). */
export function SetupActions({ setup, onRename, onDeleted }: { setup: SuspensionSetup; onRename: () => void; onDeleted: () => void }) {
  const { busy, error, run } = useRun();
  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {!setup.isActive ? (
          <Button type="button" onClick={() => void run(() => activateSetup(setup.id))} disabled={busy}>
            <CheckCircle2 aria-hidden className="size-4" />
            Set active
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={onRename} disabled={busy}>
          <Pencil aria-hidden className="size-4" />
          Rename
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || setup.isActive}
          aria-describedby={setup.isActive ? `active-delete-${setup.id}` : undefined}
          onClick={() => {
            if (window.confirm(`Delete “${setup.name}” and its history? It can be restored from Recently Deleted for 30 days.`))
              void run(() => deleteSetup(setup.id, setup.version), onDeleted);
          }}
        >
          <Trash2 aria-hidden className="size-4" />
          Delete
        </Button>
      </div>
      {setup.isActive ? (
        <p id={`active-delete-${setup.id}`} className="text-sm text-muted" data-testid="active-delete-hint">
          This is the active setup. Make another setup active before deleting it.
        </p>
      ) : null}
    </div>
  );
}

/** Create a setup (blank or copied from any revision on the sled), or rename one. */
export function SetupForm({
  sledId,
  setup,
  setups,
  revisions,
  copyFrom,
  onDone,
}: {
  sledId: string;
  setup?: SuspensionSetup;
  setups: SuspensionSetup[];
  revisions: SuspensionRevision[];
  /** Preselect a revision to copy. */
  copyFrom?: string;
  onDone: (setupId: string) => void;
}) {
  const [start, setStart] = useState<"blank" | "copy">(copyFrom ? "copy" : "blank");
  const [state, action] = useActionState<SuspensionActionState, FormData>(async (prev, formData) => {
    const result = await saveSetup(prev, formData);
    if (result.ok && result.id && !result.error) onDone(result.id);
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const nameOf = new Map(setups.map((s) => [s.id, s.name]));
  const copyable = [...revisions].sort(
    (a, b) => (nameOf.get(a.setupId) ?? "").localeCompare(nameOf.get(b.setupId) ?? "") || b.number - a.number,
  );

  return (
    <form action={action} className="space-y-5" noValidate>
      {setup ? (
        <>
          <input type="hidden" name="setupId" value={setup.id} />
          <input type="hidden" name="version" value={setup.version} />
        </>
      ) : (
        <input type="hidden" name="sledId" value={sledId} />
      )}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        label="Setup name"
        name="name"
        maxLength={80}
        autoComplete="off"
        placeholder="e.g. Trail, Deep powder, Two-up"
        defaultValue={v?.name ?? setup?.name ?? ""}
        error={errors.name?.[0]}
      />
      <TextareaField label="Notes (optional)" name="notes" maxLength={2000} defaultValue={v?.notes ?? setup?.notes ?? ""} error={errors.notes?.[0]} />
      {!setup ? (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-foreground/90">Start from</legend>
            {(
              [
                ["blank", "Blank: no values yet"],
                ["copy", "A copy of a saved revision"],
              ] as const
            ).map(([value, text]) => (
              <label
                key={value}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-white/10 px-3 has-[:checked]:border-accent",
                  value === "copy" && !copyable.length && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="radio"
                  name="start"
                  value={value}
                  checked={start === value}
                  disabled={value === "copy" && !copyable.length}
                  onChange={() => setStart(value)}
                  className="size-5 accent-[var(--color-accent)]"
                />
                <span className="text-sm font-medium">{text}</span>
              </label>
            ))}
          </fieldset>
          {start === "copy" ? (
            <SelectField
              label="Revision to copy"
              name="copyFrom"
              defaultValue={v?.copyFrom ?? copyFrom ?? copyable[0]?.id ?? ""}
              error={errors.copyFrom?.[0]}
              hint="Its values are copied for the settings that still exist. The original is not changed."
            >
              {copyable.map((r) => (
                <option key={r.id} value={r.id}>
                  {nameOf.get(r.setupId) ?? "Setup"} · Rev {r.number}
                  {latestRevision(revisions, r.setupId)?.id === r.id ? " (latest)" : ""}
                </option>
              ))}
            </SelectField>
          ) : null}
          <CheckboxField
            label="Make this the active setup"
            name="activate"
            hint={setups.some((s) => s.isActive) ? "The current active setup will be switched off." : "No setup is active yet."}
          />
        </>
      ) : null}
      <FormActions>
        <SubmitButton pendingText="Saving…">{setup ? "Save changes" : "Create setup"}</SubmitButton>
      </FormActions>
    </form>
  );
}

/** One-line summary of the selected setup: latest revision and when it was saved. */
export function SetupSummary({ setup, revisions }: { setup: SuspensionSetup; revisions: SuspensionRevision[] }) {
  const latest = latestRevision(revisions, setup.id);
  const count = revisions.filter((r) => r.setupId === setup.id).length;
  return (
    <p className="text-sm text-muted" data-testid="setup-summary">
      {latest ? (
        <>
          Revision {latest.number} · saved <LocalDate value={latest.createdAt} /> by {latest.createdByName}
          {count > 1 ? ` · ${count} revisions` : ""}
        </>
      ) : (
        "No revisions yet."
      )}
    </p>
  );
}

