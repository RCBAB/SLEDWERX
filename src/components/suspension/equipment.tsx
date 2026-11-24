"use client";

import { AlertTriangle, ArrowRight } from "lucide-react";
import { useState } from "react";

import { changeEquipment, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  CARBIDE_LENGTHS,
  SKI_LABEL,
  SKI_MODELS,
  carbideLabel,
  describeEquipment,
  sameEquipment,
  type CarbideLength,
  type Equipment,
  type SkiModel,
  type Snapshot,
  type SuspensionRevision,
} from "@/lib/suspension/types";
import { randomUuid } from "@/lib/uuid";
import { dislikeWarning, matchingConfigurations } from "@/lib/suspension/warnings";

function Choice<T extends string>({
  legend,
  name,
  options,
  value,
  label,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  value: T | null;
  label: (option: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-foreground/90">{legend}</legend>
      <div className={cn("grid gap-2", options.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {options.map((option) => (
          <label
            key={option}
            className={cn(
              "flex min-h-14 cursor-pointer items-center justify-center rounded-lg px-3 text-center font-bold ring-1",
              "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
              value === option ? "bg-accent/15 text-foreground ring-2 ring-accent" : "bg-white/5 text-muted ring-white/10",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {label(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Change the installed skis and carbides (same data on the snowmobile page,
 * the Garage Board and Quick Tune). Two steps: choose, then confirm. Confirming
 * saves the next Trail configuration with every suspension value copied and
 * the new equipment, and makes it active; the previous configuration keeps
 * the skis and carbides it was saved with.
 */
export function EquipmentForm({
  sledId,
  activeRevisionId,
  activeName,
  installed,
  values,
  revisions,
  onDone,
}: {
  sledId: string;
  activeRevisionId: string | null;
  /** "Trail 4" (null before the first configuration). */
  activeName: string | null;
  installed: Equipment;
  /** The active configuration's values (copied into the new one). */
  values: Snapshot;
  /** For the disliked-before warning (optional). */
  revisions?: SuspensionRevision[];
  onDone: (result: SuspensionActionState) => void;
}) {
  const [ski, setSki] = useState<SkiModel | null>(installed.ski);
  const [carbide, setCarbide] = useState<CarbideLength | null>(installed.carbide);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [key] = useState(randomUuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next: Equipment = { ski, carbide };
  const unchanged = sameEquipment(next, installed);
  const warning = revisions && ski && carbide ? dislikeWarning(matchingConfigurations({ values, equipment: next }, revisions)) : null;

  const confirm = async () => {
    if (!ski || !carbide) return;
    setBusy(true);
    setError(null);
    try {
      const result = await changeEquipment({ sledId, baseRevisionId: activeRevisionId, ski, carbide, idempotencyKey: key });
      if (result.ok) onDone(result);
      else setError(result.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "confirm" && ski && carbide) {
    return (
      <div className="space-y-5" data-testid="equipment-confirm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="rounded-xl border border-white/10 bg-background/40 p-4">
          <p className="text-sm text-muted">Change the installed equipment</p>
          <p className="mt-2 flex flex-wrap items-center gap-2 font-semibold">
            <span className="text-muted">{describeEquipment(installed)}</span>
            <ArrowRight aria-hidden className="size-4 text-muted" />
            <span data-testid="equipment-next">{describeEquipment(next)}</span>
          </p>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/90">
          <li>{activeName ? `${activeName} is kept as it is.` : "Nothing saved earlier is changed."}</li>
          <li>The next Trail configuration is created with every suspension value copied.</li>
          <li>It records {describeEquipment(next)} and becomes the active configuration.</li>
        </ol>
        {warning ? (
          <div
            className="flex gap-3 rounded-xl border border-amber-300/40 bg-amber-400/10 p-4 text-sm text-amber-50"
            data-testid="dislike-warning"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
            <p>
              {warning.message} <span className="text-amber-100/80">({warning.configurations.join(", ")})</span>
            </p>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Button type="button" variant="secondary" size="lg" onClick={() => setStep("choose")} disabled={busy}>
            Back
          </Button>
          <Button type="button" size="lg" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Saving…" : "Confirm change"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="equipment-form">
      <p className="text-sm text-muted">
        Installed now: <span className="font-semibold text-foreground">{describeEquipment(installed)}</span>
      </p>
      <Choice legend="Ski model" name="ski" options={SKI_MODELS} value={ski} label={(s) => SKI_LABEL[s]} onChange={setSki} />
      <Choice legend="Carbide length" name="carbide" options={CARBIDE_LENGTHS} value={carbide} label={carbideLabel} onChange={setCarbide} />
      <Button type="button" size="lg" className="w-full" disabled={!ski || !carbide || unchanged} onClick={() => setStep("confirm")}>
        Continue
      </Button>
      {unchanged && ski && carbide ? (
        <p className="text-center text-sm text-muted">These are the skis and carbides installed now.</p>
      ) : null}
    </div>
  );
}
