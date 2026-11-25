"use client";

import { cn } from "@/components/ui/cn";

export type SegmentOption<T extends string> = { value: T; label: string; selectedClass?: string };

/**
 * A row of large radio buttons (at least 44 px tall, for gloves and the
 * garage touchscreen). The radios are real form controls, so keyboard and
 * screen readers work as usual, and the value is submitted under `name`.
 */
export function Segmented<T extends string>({
  legend,
  legendHidden,
  name,
  value,
  options,
  onChange,
  big,
  error,
  hint,
}: {
  legend: string;
  legendHidden?: boolean;
  name: string;
  value: T | null;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  big?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className={cn("mb-1.5 text-sm font-medium text-foreground/90", legendHidden && "sr-only")}>{legend}</legend>
      <div className={cn("grid gap-2", options.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-center justify-center rounded-lg px-2 text-center font-semibold leading-tight ring-1",
              "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
              big ? "min-h-14 text-base" : "min-h-11 text-sm",
              value === option.value
                ? (option.selectedClass ?? "bg-primary text-white ring-primary")
                : "bg-white/5 text-muted ring-white/10 hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error ? <p className="mt-1 text-sm text-accent-hot">{error}</p> : hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
    </fieldset>
  );
}
