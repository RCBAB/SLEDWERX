"use client";

import { ImagePlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, type ChangeEvent } from "react";

import { attachNewSledPhoto, createSled, updateSled, type SledActionState } from "@/app/garage/actions";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { CheckboxField, Field, SelectField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { MAKE_SUGGESTIONS, SLED_STATUSES, STATUS_LABELS, type SledStatus } from "@/lib/sleds/constants";
import { discardUploadedPhoto, PhotoError, resizePhoto, uploadSledPhoto } from "@/lib/sleds/photo-upload";
import { useLocalToday } from "@/lib/sleds/use-local-today";

import { SledPhoto } from "./sled-photo";

export type SledFormSled = {
  id: string;
  make: string;
  model: string;
  modelYear: number;
  nickname: string | null;
  vin: string | null;
  status: SledStatus;
  purchaseDate: string | null;
  engineDescription: string | null;
  displacementCc: number | null;
  notes: string | null;
  photoUrl: string | null;
  version: number;
};

type Props = { mode: "create" } | { mode: "edit"; sled: SledFormSled };

function textOf(value: string | number | null | undefined) {
  return value == null ? "" : String(value);
}

export function SledForm(props: Props) {
  const router = useRouter();
  const today = useLocalToday();
  const sled = props.mode === "edit" ? props.sled : null;
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [state, formAction] = useActionState<SledActionState, FormData>(async (prev, formData) => {
    const photo = formData.get("photo");
    formData.delete("photo"); // the file goes straight to Storage, not through the server
    const file = photo instanceof File && photo.size > 0 ? photo : null;

    if (props.mode === "create") {
      const result = await createSled(prev, formData);
      if (!result.ok || !result.sledId) return result;

      let photoFailed = false;
      if (file) {
        let path: string | null = null;
        try {
          path = await uploadSledPhoto(result.sledId, file);
          const attached = await attachNewSledPhoto(result.sledId, path);
          if (!attached.ok) throw new Error(attached.error);
        } catch {
          photoFailed = true;
          if (path) await discardUploadedPhoto(path);
        }
      }
      router.push(`/garage/${result.sledId}?${photoFailed ? "photo=failed" : "added=1"}`);
      return result;
    }

    let uploaded: string | null = null;
    if (file) {
      try {
        uploaded = await uploadSledPhoto(props.sled.id, file);
      } catch (error) {
        return {
          error: error instanceof PhotoError ? error.message : "The photo couldn't be uploaded. Please try again.",
          values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])),
        };
      }
      formData.set("photoPath", uploaded);
    }
    const result = await updateSled(prev, formData);
    if (!result.ok) {
      if (uploaded) await discardUploadedPhoto(uploaded);
      return result;
    }
    router.push(`/garage/${props.sled.id}?saved=1`);
    return result;
  }, {});

  const values = state.values;
  const errors = state.fieldErrors ?? {};
  const value = (key: string, fallback: string | number | null | undefined) =>
    values ? (values[key] ?? "") : textOf(fallback);

  const detailsHaveContent = Boolean(
    sled &&
      (sled.purchaseDate || sled.engineDescription || sled.displacementCc || sled.notes || sled.status !== "ready"),
  );
  const detailsHaveErrors = ["status", "purchaseDate", "engineDescription", "displacementCc", "notes"].some(
    (key) => errors[key],
  );

  // Re-mount the form fields when the server sends values back, so they show
  // what the user typed.
  const formKey = values ? JSON.stringify(values) : "initial";

  return (
    <form action={formAction} className="space-y-8" noValidate key={formKey}>
      {sled ? (
        <>
          <input type="hidden" name="sledId" value={sled.id} />
          <input type="hidden" name="version" value={sled.version} />
        </>
      ) : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="space-y-5">
        <legend className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Snowmobile</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Manufacturer"
            name="make"
            list="make-suggestions"
            autoComplete="off"
            required
            maxLength={60}
            defaultValue={value("make", sled?.make)}
            error={errors.make?.[0]}
          />
          <datalist id="make-suggestions">
            {MAKE_SUGGESTIONS.map((make) => (
              <option key={make} value={make} />
            ))}
          </datalist>
          <Field
            label="Model"
            name="model"
            required
            maxLength={80}
            placeholder="e.g. RMK Khaos 850"
            defaultValue={value("model", sled?.model)}
            error={errors.model?.[0]}
          />
          <Field
            label="Model year"
            name="modelYear"
            inputMode="numeric"
            required
            maxLength={4}
            placeholder="e.g. 2024"
            defaultValue={value("modelYear", sled?.modelYear)}
            error={errors.modelYear?.[0]}
          />
          <Field
            label="Nickname (optional)"
            name="nickname"
            maxLength={60}
            defaultValue={value("nickname", sled?.nickname)}
            error={errors.nickname?.[0]}
          />
          <Field
            label="VIN or serial number (optional)"
            name="vin"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            defaultValue={value("vin", sled?.vin)}
            error={errors.vin?.[0]}
            className="sm:col-span-2"
          />
        </div>
      </fieldset>

      {props.mode === "create" ? (
        <fieldset className="space-y-5">
          <legend className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Current meters</legend>
          <input type="hidden" name="readOn" value={today} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Odometer (miles)"
              name="odometer"
              inputMode="decimal"
              required
              placeholder="0"
              hint="Enter 0 for a brand-new snowmobile."
              defaultValue={value("odometer", null)}
              error={errors.odometer?.[0]}
            />
            <Field
              label="Engine hours (optional)"
              name="engineHours"
              inputMode="decimal"
              defaultValue={value("engineHours", null)}
              error={errors.engineHours?.[0]}
            />
          </div>
        </fieldset>
      ) : null}

      <PhotoField currentUrl={sled?.photoUrl ?? null} error={photoError} onError={setPhotoError} canRemove={Boolean(sled)} />

      {sled ? (
        <details
          className="group rounded-2xl border border-white/10 bg-surface/40 open:bg-surface/60"
          open={detailsHaveContent || detailsHaveErrors}
        >
          <summary className="cursor-pointer list-none px-5 py-4 font-semibold marker:hidden">
            More details
            <span className="ml-2 text-sm font-normal text-muted">status, purchase date, engine, notes</span>
          </summary>
          <div className="grid gap-5 border-t border-white/10 p-5 sm:grid-cols-2">
            <SelectField
              label="Status"
              name="status"
              defaultValue={value("status", sled.status)}
              error={errors.status?.[0]}
            >
              {SLED_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </SelectField>
            <Field
              label="Purchase date"
              name="purchaseDate"
              type="date"
              max={today || undefined}
              defaultValue={value("purchaseDate", sled.purchaseDate)}
              error={errors.purchaseDate?.[0]}
            />
            <Field
              label="Engine"
              name="engineDescription"
              maxLength={200}
              placeholder="e.g. Patriot 850 two-stroke"
              defaultValue={value("engineDescription", sled.engineDescription)}
              error={errors.engineDescription?.[0]}
            />
            <Field
              label="Displacement (cc)"
              name="displacementCc"
              inputMode="numeric"
              defaultValue={value("displacementCc", sled.displacementCc)}
              error={errors.displacementCc?.[0]}
            />
            <TextareaField
              label="Notes"
              name="notes"
              maxLength={10000}
              defaultValue={value("notes", sled.notes)}
              error={errors.notes?.[0]}
              className="sm:col-span-2"
            />
          </div>
        </details>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <ButtonLink href={sled ? `/garage/${sled.id}` : "/garage"} variant="secondary" size="lg">
          Cancel
        </ButtonLink>
        <div className="sm:w-56">
          <SubmitButton pendingText={props.mode === "create" ? "Adding…" : "Saving…"}>
            {props.mode === "create" ? "Add snowmobile" : "Save changes"}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

function PhotoField({
  currentUrl,
  error,
  onError,
  canRemove,
}: {
  currentUrl: string | null;
  error: string | null;
  onError: (message: string | null) => void;
  canRemove: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    onError(null);
    setPreview(null);
    if (!file) return;
    try {
      // Check early that the photo can be read, so problems show before saving.
      const blob = await resizePhoto(file);
      setPreview(URL.createObjectURL(blob));
      setRemoved(false);
    } catch (problem) {
      event.target.value = "";
      onError(problem instanceof PhotoError ? problem.message : "This photo couldn't be read.");
    }
  }

  const shown = preview ?? (removed ? null : currentUrl);
  return (
    <fieldset>
      <legend className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-muted">Photo (optional)</legend>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <SledPhoto url={shown} alt="Snowmobile photo" className="aspect-[16/10] w-full rounded-xl sm:w-56" />
        <div className="space-y-3">
          <label
            htmlFor="photo"
            className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 text-sm font-semibold hover:bg-white/10 focus-within:outline-2 focus-within:outline-accent"
          >
            <ImagePlus aria-hidden className="size-4" />
            {shown ? "Choose a different photo" : "Choose a photo"}
            <input
              id="photo"
              name="photo"
              type="file"
              accept="image/*"
              className="sr-only"
              aria-describedby={error ? "photo-error" : "photo-hint"}
              onChange={onChange}
            />
          </label>
          {error ? (
            <p id="photo-error" className="text-sm text-accent-hot">
              {error}
            </p>
          ) : (
            <p id="photo-hint" className="text-sm text-muted">
              Resized before upload. Only you and people you share this snowmobile with can see it.
            </p>
          )}
          {canRemove && currentUrl && !preview ? (
            <CheckboxField
              label="Remove photo"
              name="removePhoto"
              checked={removed}
              onChange={(event) => setRemoved(event.target.checked)}
            />
          ) : null}
          {preview ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
              onClick={() => {
                setPreview(null);
                const input = document.getElementById("photo") as HTMLInputElement | null;
                if (input) input.value = "";
              }}
            >
              <X aria-hidden className="size-4" /> Don&apos;t use this photo
            </button>
          ) : null}
        </div>
      </div>
    </fieldset>
  );
}
