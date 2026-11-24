"use client";

import { AlertTriangle, Wrench } from "lucide-react";
import { useState } from "react";

import { activateConfiguration, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeChange, equipmentChanges, revisionChanges } from "@/lib/suspension/diff";
import {
  ZONE_LABEL,
  configName,
  describeEquipment,
  equipmentMismatch,
  type Equipment,
  type SuspensionRevision,
  type SuspensionSetting,
} from "@/lib/suspension/types";
import { dislikeWarning, matchingConfigurations } from "@/lib/suspension/warnings";

/**
 * Make an earlier configuration active. Selecting and viewing never activate
 * anything; this form is the only step that does, and it never creates a new
 * configuration. If the configuration was saved with other skis or carbides,
 * the user must confirm they have been installed before the installed
 * equipment is updated; Cancel changes nothing.
 */
export function ActivateForm({
  revision,
  active,
  installed,
  revisions,
  settings,
  onDone,
  onCancel,
}: {
  revision: SuspensionRevision;
  active: SuspensionRevision | undefined;
  installed: Equipment;
  revisions: SuspensionRevision[];
  settings: SuspensionSetting[];
  onDone: (result: SuspensionActionState) => void;
  onCancel: () => void;
}) {
  const [installedConfirmed, setInstalledConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = configName(revision.configNumber);
  const mismatch = equipmentMismatch(revision.equipment, installed);
  const changes = revisionChanges(active?.values ?? null, revision.values, settings);
  const equipment = active ? equipmentChanges(active.equipment, revision.equipment) : [];
  const warning = dislikeWarning(matchingConfigurations(revision, revisions));

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await activateConfiguration(revision.id, mismatch && installedConfirmed);
      if (result.ok) onDone(result);
      else setError(result.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="activate-form">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-foreground/90">
        Make <span className="font-semibold">{name}</span> the active configuration
        {active ? (
          <>
            {" "}
            instead of <span className="font-semibold">{configName(active.configNumber)}</span>
          </>
        ) : null}
        ? No new configuration is created and nothing is changed in either one.
      </p>

      {active ? (
        <div className="rounded-xl border border-white/10 bg-background/40 p-4 text-sm" data-testid="activate-changes">
          <p className="mb-2 font-semibold">
            {configName(active.configNumber)} → {name}
          </p>
          {changes.length || equipment.length ? (
            <ul className="space-y-1">
              {changes.map((c) => (
                <li key={c.settingId} className="flex flex-wrap gap-x-2">
                  <span className="text-muted">{ZONE_LABEL[c.zone]}</span>
                  <span className="font-medium">{describeChange(c)}</span>
                </li>
              ))}
              {equipment.map((line) => (
                <li key={line} className="font-medium">
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Same values and equipment.</p>
          )}
        </div>
      ) : null}

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

      {mismatch ? (
        <div className="space-y-3 rounded-xl border border-accent/50 bg-accent/10 p-4 text-sm" data-testid="equipment-mismatch">
          <p className="flex gap-2 font-semibold">
            <Wrench aria-hidden className="mt-0.5 size-4 shrink-0" />
            Different skis or carbides
          </p>
          <dl className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-muted">{name} was set up with</dt>
            <dd className="font-semibold" data-testid="required-equipment">
              {describeEquipment(revision.equipment)}
            </dd>
            <dt className="text-muted">Installed now</dt>
            <dd className="font-semibold" data-testid="installed-equipment">
              {describeEquipment(installed)}
            </dd>
          </dl>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-5 accent-[var(--color-primary)]"
              checked={installedConfirmed}
              onChange={(e) => setInstalledConfirmed(e.target.checked)}
            />
            <span>I&apos;ve installed {describeEquipment(revision.equipment)}. Update the installed equipment.</span>
          </label>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="secondary" size="lg" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="lg" onClick={() => void activate()} disabled={busy || (mismatch && !installedConfirmed)}>
          {busy ? "Activating…" : `Activate ${name}`}
        </Button>
      </div>
    </div>
  );
}
