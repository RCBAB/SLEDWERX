"use client";

import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useActionState, useState } from "react";

import {
  addPackageTask,
  deletePackage,
  deleteTask,
  movePackageTask,
  removePackageTask,
  renamePackage,
  renameTask,
  type LibraryActionState,
} from "@/app/garage/library/actions";
import { Button } from "@/components/ui/button";
import { Field, SelectField } from "@/components/ui/field";
import type { LibraryTask, MaintenancePackage } from "@/lib/service/queries";

type Action = (prev: LibraryActionState, formData: FormData) => Promise<LibraryActionState>;

const iconButton = "p-2 text-muted hover:text-foreground disabled:opacity-30";

/** "Add" form: one name field and a button. Resets after each save. */
export function AddNameForm({
  action,
  label,
  button,
  sledId,
  placeholder,
}: {
  action: Action;
  label: string;
  button: string;
  sledId?: string;
  placeholder?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex items-start gap-2" key={state.savedAt ?? "form"} noValidate>
      {sledId ? <input type="hidden" name="sledId" value={sledId} /> : null}
      <Field
        label={label}
        name="name"
        maxLength={120}
        placeholder={placeholder}
        error={state.fieldErrors?.name?.[0] ?? state.error}
        className="flex-1"
      />
      <Button type="submit" variant="secondary" className="mt-7 h-12" disabled={pending}>
        <Plus aria-hidden className="size-4" />
        {button}
      </Button>
    </form>
  );
}

/** A task (or package name) that can be renamed and deleted. */
export function NamedRow({
  id,
  name,
  version,
  kind,
  canChange = true,
}: {
  id: string;
  name: string;
  version: number;
  kind: "task" | "package";
  canChange?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [renameState, renameAction, renaming] = useActionState<LibraryActionState, FormData>(async (prev, formData) => {
    const result = await (kind === "task" ? renameTask : renamePackage)(prev, formData);
    if (result.ok) setEditing(false);
    return result;
  }, {});
  const [deleteState, deleteAction, deleting] = useActionState(kind === "task" ? deleteTask : deletePackage, {});
  const error = renameState.fieldErrors?.name?.[0] ?? renameState.error ?? deleteState.error;

  if (editing) {
    return (
      <form action={renameAction} className="flex items-center gap-2" noValidate>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="version" value={version} />
        <input
          name="name"
          defaultValue={name}
          maxLength={120}
          aria-label={`New name for ${name}`}
          autoFocus
          className="h-10 flex-1 rounded-lg border border-white/15 bg-black/30 px-3 text-sm"
        />
        <button type="submit" className={iconButton} aria-label="Save name" disabled={renaming}>
          <Check aria-hidden className="size-4" />
        </button>
        <button type="button" className={iconButton} aria-label="Cancel" onClick={() => setEditing(false)}>
          <X aria-hidden className="size-4" />
        </button>
        {error ? <p className="text-sm text-accent-hot">{error}</p> : null}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 font-medium">{name}</span>
      {canChange ? (
        <>
          <button type="button" className={iconButton} aria-label={`Rename ${name}`} onClick={() => setEditing(true)}>
            <Pencil aria-hidden className="size-4" />
          </button>
          <form
            action={deleteAction}
            onSubmit={(event) => {
              if (!window.confirm(`Delete “${name}”? Past services keep its name.`)) event.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="version" value={version} />
            <button type="submit" className={iconButton} aria-label={`Delete ${name}`} disabled={deleting}>
              <Trash2 aria-hidden className="size-4" />
            </button>
          </form>
        </>
      ) : null}
      {error ? <p className="text-sm text-accent-hot">{error}</p> : null}
    </div>
  );
}

/** A package: its tasks in order, with add, remove and reorder. */
export function PackageCard({ pkg, libraryTasks }: { pkg: MaintenancePackage; libraryTasks: LibraryTask[] }) {
  const [addState, addAction, adding] = useActionState(addPackageTask, {});
  const [moveState, moveAction] = useActionState(movePackageTask, {});
  const [removeState, removeAction] = useActionState(removePackageTask, {});
  const available = libraryTasks.filter((t) => !pkg.items.some((i) => i.taskId === t.id));
  const error = addState.fieldErrors?.taskId?.[0] ?? addState.error ?? moveState.error ?? removeState.error;

  return (
    <li className="rounded-2xl border border-white/10 bg-surface/70 p-4" data-testid="package-card">
      <NamedRow id={pkg.id} name={pkg.name} version={pkg.version} kind="package" />
      {pkg.items.length ? (
        <ol className="mt-3 divide-y divide-white/5 rounded-xl border border-white/10">
          {pkg.items.map((item, index) => (
            <li key={item.id} className="flex items-center gap-1 px-3 py-1.5 text-sm">
              <span className="w-6 tabular-nums text-muted">{index + 1}.</span>
              <span className="flex-1">{item.name}</span>
              {(["up", "down"] as const).map((direction) => (
                <form key={direction} action={moveAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="packageId" value={pkg.id} />
                  <input type="hidden" name="direction" value={direction} />
                  <button
                    type="submit"
                    className={iconButton}
                    aria-label={`Move ${item.name} ${direction}`}
                    disabled={direction === "up" ? index === 0 : index === pkg.items.length - 1}
                  >
                    {direction === "up" ? <ArrowUp aria-hidden className="size-4" /> : <ArrowDown aria-hidden className="size-4" />}
                  </button>
                </form>
              ))}
              <form action={removeAction}>
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="version" value={item.version} />
                <button type="submit" className={iconButton} aria-label={`Remove ${item.name} from ${pkg.name}`}>
                  <X aria-hidden className="size-4" />
                </button>
              </form>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted">No tasks yet.</p>
      )}
      {available.length ? (
        <form action={addAction} className="mt-3 flex items-end gap-2" key={addState.savedAt ?? "add"}>
          <input type="hidden" name="packageId" value={pkg.id} />
          <SelectField label={`Add a task to ${pkg.name}`} name="taskId" defaultValue="" className="flex-1">
            <option value="">Choose a task…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
          <Button type="submit" variant="secondary" className="h-12" disabled={adding}>
            Add
          </Button>
        </form>
      ) : libraryTasks.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Add tasks to your library first.</p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-accent-hot">{error}</p> : null}
    </li>
  );
}
