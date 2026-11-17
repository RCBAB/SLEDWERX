"use client";

import { useId, type ComponentProps } from "react";

import { cn } from "./cn";

/**
 * A unique id for a field. Next.js can keep a previously visited page mounted
 * (hidden) for instant back navigation, so ids derived from field names alone
 * could collide across pages and point labels at the wrong input.
 */
function useFieldId(id: string | undefined, name: string) {
  const unique = useId();
  return id ?? `${name}-${unique.replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
  const id = useFieldId(inputProps.id, name);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <input
        {...inputProps}
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "block h-12 w-full rounded-lg border bg-black/30 px-3.5 text-base text-foreground",
          "placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent",
          error ? "border-accent" : "border-white/15",
        )}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-accent-hot">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

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
  const id = useFieldId(props.id, name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <select
        {...props}
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(controlClasses(error), "h-12")}
      >
        {children}
      </select>
      <FieldMessage id={id} error={error} hint={hint} />
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
  const id = useFieldId(props.id, name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <textarea
        {...props}
        id={id}
        name={name}
        rows={4}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(controlClasses(error), "py-3")}
      />
      <FieldMessage id={id} error={error} hint={hint} />
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
  const id = useFieldId(props.id, name);
  return (
    <div className={cn("flex gap-3", className)}>
      <input
        {...props}
        id={id}
        name={name}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 size-5 shrink-0 rounded border-white/20 bg-black/30 accent-[var(--color-accent)]"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-foreground/90">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
