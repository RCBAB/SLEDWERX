import type { ComponentProps } from "react";

import { cn } from "./cn";

/** A labelled input with its validation message. */
export function Field({
  label,
  name,
  error,
  hint,
  className,
  ...inputProps
}: ComponentProps<"input"> & { label: string; name: string; error?: string; hint?: string }) {
  const id = inputProps.id ?? name;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "block h-12 w-full rounded-lg border bg-black/30 px-3.5 text-base text-foreground",
          "placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent",
          error ? "border-accent" : "border-white/15",
        )}
        {...inputProps}
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
