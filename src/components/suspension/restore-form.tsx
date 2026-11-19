"use client";

import { useActionState, useState } from "react";

import { restoreRevision, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Field, TextareaField } from "@/components/ui/field";
import { FormActions } from "@/components/ui/form-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { describeChange, revisionChanges } from "@/lib/suspension/diff";
import { ZONE_LABEL, restorableValues, type SuspensionRevision, type SuspensionSetting } from "@/lib/suspension/types";
import { randomUuid } from "@/lib/uuid";

/**
 * Restore an earlier revision: saves a NEW revision with its values (for the
 * settings that are still on the sled). Nothing is overwritten or erased.
 * Shows exactly what will change against the current revision first.
 */
export function RestoreForm({
  revision,
  current,
  setupName,
  settings,
  odometer,
  engineHours,
  onDone,
}: {
  revision: SuspensionRevision;
  current: SuspensionRevision;
  setupName: string;
  settings: SuspensionSetting[];
  odometer: number | null;
  engineHours: number | null;
  onDone: (result: SuspensionActionState) => void;
}) {
  const [key] = useState(randomUuid);
  const [state, action] = useActionState<SuspensionActionState, FormData>(async (prev, formData) => {
    const result = await restoreRevision(prev, formData);
    if (result.ok) onDone(result);
    return result;
  }, {});
  const errors = state.fieldErrors ?? {};
  const v = state.values;

  const target = restorableValues(revision.values, settings);
  const changes = revisionChanges(restorableValues(current.values, settings), target, settings);
  const dropped = Object.entries(revision.values).filter(([id]) => !target[id]);

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="revisionId" value={revision.id} />
      <input type="hidden" name="idempotencyKey" value={key} />
      {state.error && !state.fieldErrors ? <Alert tone="error">{state.error}</Alert> : null}

      <p className="text-sm text-foreground/90">
        Saves a new revision of {setupName} with the values of rev {revision.number}. Rev {current.number} and all earlier revisions stay in
        the history.
      </p>

      <div className="rounded-xl border border-white/10 p-4 text-sm" data-testid="restore-changes">
        {changes.length ? (
          <>
            <p className="font-semibold">
              {changes.length} change{changes.length === 1 ? "" : "s"} from rev {current.number}
            </p>
            <ul className="mt-2 space-y-1">
              {changes.map((change) => (
                <li key={change.settingId} className="flex flex-wrap gap-x-2">
                  <span className="text-muted">{ZONE_LABEL[change.zone]}</span>
                  <span className="font-medium">{describeChange(change)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="font-semibold">Rev {current.number} already has these values.</p>
        )}
        {dropped.length ? (
          <p className="mt-3 text-muted" data-testid="restore-dropped">
            Not restored (removed from the settings list since): {dropped.map(([, entry]) => entry.name).join(", ")}.
          </p>
        ) : null}
      </div>

      <TextareaField
        label="Note (optional)"
        name="note"
        maxLength={2000}
        placeholder={`Restored revision ${revision.number}`}
        defaultValue={v?.note ?? ""}
        error={errors.note?.[0]}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Mileage"
          name="odometer"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v?.odometer ?? odometer?.toString() ?? ""}
          error={errors.odometer?.[0]}
        />
        <Field
          label="Engine hours"
          name="engineHours"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={v?.engineHours ?? engineHours?.toString() ?? ""}
          error={errors.engineHours?.[0]}
        />
      </div>
      <p className="-mt-3 text-sm text-muted">
        Copied from the current readings. Changing them here doesn&apos;t change the sled&apos;s readings.
      </p>
      <FormActions>
        <SubmitButton pendingText="Restoring…">{`Restore rev ${revision.number}`}</SubmitButton>
      </FormActions>
    </form>
  );
}
