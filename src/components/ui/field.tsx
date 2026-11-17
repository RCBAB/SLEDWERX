"use client";

import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "./cn";

// Labels wrap their control instead of pointing at it by id. Next.js keeps
// recently visited pages mounted (hidden) for instant back navigation, so an
// id-based label could end up pointing at the same field on a hidden page.
// A wrapping label can only ever belong to its own control. The control also
// gets the label as its accessible name, so typed values never change it.

/** An id for hint and error text (only referenced from within this field). */
function useMessageId(name: string) {
  return `${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

const labelText = "block text-sm font-medium text-foreground/90";

const controlClasses = (error?: string) =>
  cn(
    "block w-full rounded-lg border bg-black/30 px-3.5 text-base text-foreground",
    "placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent",
    error ? "border-accent" : "border-white/15",
  );

function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (error) {
    return (
      <p id={`${id}-error`} className="text-sm text-accent-hot">
        {error}
      </p>
    );
  }
  return hint ? (
    <p id={`${id}-hint`} className="text-sm text-muted">
      {hint}
    </p>
  ) : null;
}

function describedBy(id: string, error?: string, hint?: string) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

function LabelledControl({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className={labelText}>{label}</span>
      {children}
    </label>
  );
}

/** A labelled input with its validation message. */
export function Field({
  label,
  name,
  error,
  hint,
  className,
  ...inputProps
}: ComponentProps<"input"> & { label: string; name: string; error?: string; hint?: string }) {
  const messageId = useMessageId(name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <LabelledControl label={label}>
        <input
          {...inputProps}
          name={name}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(messageId, error, hint)}
          className={cn(controlClasses(error), "h-12")}
        />
      </LabelledControl>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/** A labelled select with its validation message. */
export function SelectField({
  label,
  name,
  error,
  hint,
  className,
  children,
  ...props
}: ComponentProps<"select"> & { label: string; name: string; error?: string; hint?: string }) {
  const messageId = useMessageId(name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <LabelledControl label={label}>
        <select
          {...props}
          name={name}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(messageId, error, hint)}
          className={cn(controlClasses(error), "h-12")}
        >
          {children}
        </select>
      </LabelledControl>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/** A labelled multi-line text field with its validation message. */
export function TextareaField({
  label,
  name,
  error,
  hint,
  className,
  ...props
}: ComponentProps<"textarea"> & { label: string; name: string; error?: string; hint?: string }) {
  const messageId = useMessageId(name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <LabelledControl label={label}>
        <textarea
          {...props}
          name={name}
          rows={4}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(messageId, error, hint)}
          className={cn(controlClasses(error), "py-3")}
        />
      </LabelledControl>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/** A checkbox with its label to the right. */
export function CheckboxField({
  label,
  name,
  hint,
  className,
  ...props
}: ComponentProps<"input"> & { label: string; name: string; hint?: string }) {
  const messageId = useMessageId(name);
  return (
    <div className={className}>
      <label className="flex gap-3">
        <input
          {...props}
          name={name}
          type="checkbox"
          aria-label={label}
          aria-describedby={hint ? `${messageId}-hint` : undefined}
          className="mt-0.5 size-5 shrink-0 rounded border-white/20 bg-black/30 accent-[var(--color-accent)]"
        />
        <span className="text-sm font-medium text-foreground/90">{label}</span>
      </label>
      {hint ? (
        <p id={`${messageId}-hint`} className="ml-8 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
