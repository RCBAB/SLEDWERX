"use client";

import { ArrowLeft, Camera, ExternalLink, ImagePlus, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { removeMeasurementPhoto } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { saveMeasurementPhoto } from "@/lib/suspension/measurement-photo-upload";
import { MAX_MEASUREMENT_PHOTOS, configName, type MeasurementPhoto, type SuspensionRevision } from "@/lib/suspension/types";

/** The small camera + "1/2" beside a measurement. */
export function MeasurementPhotoButton({
  count,
  name,
  configNumber,
  side,
  onClick,
}: {
  count: number;
  /** "Sag", "Compression (Left)". */
  name: string;
  configNumber: number;
  /** "L" / "R" on a combined left/right row. */
  side?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Measurement photos of ${name} on ${configName(configNumber)}, ${count} of ${MAX_MEASUREMENT_PHOTOS}`}
      className={cn(
        "-ml-2 inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold hover:bg-white/5 hover:text-foreground",
        count ? "text-foreground/90" : "text-muted",
      )}
      data-testid="measurement-photo-button"
      data-count={count}
    >
      <Camera aria-hidden className="size-4" />
      {side ? <span>{side}</span> : null}
      <span className="tabular-nums">
        {count}/{MAX_MEASUREMENT_PHOTOS}
      </span>
    </button>
  );
}

/**
 * The photos of one measurement on one configuration: up to two, each with
 * View (enlarged), Replace and Remove; empty slots offer Take photo (phone
 * camera) and Choose photo. Changes here never create a configuration and
 * never change values or which configuration is active.
 */
export function MeasurementPhotoManager({
  sledId,
  revision,
  settingId,
  name,
  photos,
  canAdd,
  canReplace,
  canRemove,
}: {
  sledId: string;
  revision: Pick<SuspensionRevision, "id" | "configNumber">;
  settingId: string;
  name: string;
  photos: MeasurementPhoto[];
  canAdd: boolean;
  canReplace: boolean;
  canRemove: boolean;
}) {
  const [viewing, setViewing] = useState<MeasurementPhoto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const trail = configName(revision.configNumber);
  const target = { sledId, revisionId: revision.id, settingId };
  const firstOutdated = photos.filter((p) => p.inherited && p.outdated).sort((a, b) => a.slot - b.slot)[0]?.slot ?? null;

  const run = async (key: string, work: () => Promise<string | null>, success: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const error = await work();
      setMessage(error ? { tone: "error", text: error } : { tone: "success", text: success });
    } catch {
      setMessage({ tone: "error", text: "Something went wrong. Please try again." });
    } finally {
      setBusy(null);
    }
  };

  if (viewing) {
    return (
      <div className="space-y-3" data-testid="measurement-photo-viewer">
        <Button type="button" variant="ghost" onClick={() => setViewing(null)}>
          <ArrowLeft aria-hidden className="size-4" />
          Back to photos
        </Button>
        {viewing.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={viewing.url}
            alt={`Photo ${viewing.slot} of ${name} on ${trail}, enlarged`}
            className="max-h-[70vh] w-full rounded-xl bg-black object-contain"
          />
        ) : (
          <p className="text-muted">This photo is unavailable. Reload the page to try again.</p>
        )}
        {viewing.url ? (
          <a
            href={viewing.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent-hot underline-offset-4 hover:underline"
          >
            <ExternalLink aria-hidden className="size-4" />
            Open full size
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="measurement-photos" data-revision={revision.id}>
      <p className="text-sm text-muted">
        Photos of <span className="font-semibold text-foreground">{name}</span> on{" "}
        <span className="font-semibold text-foreground" data-testid="measurement-trail">
          {trail}
        </span>
        . They belong to {trail} only; changing them never creates a new Trail configuration. A new configuration starts with the photos of
        the one it was made from.
      </p>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: MAX_MEASUREMENT_PHOTOS }, (_, n) => {
          const slot = n + 1;
          const photo = photos.find((p) => p.slot === slot);
          return (
            <li
              key={slot}
              className="space-y-2 rounded-xl border border-white/10 bg-background/40 p-3"
              data-testid="measurement-slot"
              data-filled={photo ? "true" : "false"}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Photo {slot}</p>
              {photo?.inherited ? (
                <p
                  className={cn("text-xs font-semibold", photo.outdated ? "text-amber-100" : "text-muted")}
                  data-testid={photo.outdated ? "photo-outdated" : "photo-previous"}
                >
                  {photo.outdated ? "Previous Trail photo · outdated (the setting changed since)" : "Previous Trail photo"}
                </p>
              ) : null}
              {photo ? (
                <>
                  <button
                    type="button"
                    onClick={() => setViewing(photo)}
                    className="block w-full overflow-hidden rounded-lg"
                    aria-label={`View photo ${slot} of ${name} on ${trail}`}
                  >
                    {photo.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photo.url} alt={`Photo ${slot} of ${name} on ${trail}`} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                      <span className="grid aspect-[4/3] place-items-center bg-white/5 text-xs text-muted">Photo unavailable</span>
                    )}
                  </button>
                  <div className="flex flex-wrap gap-2">
                    {canReplace ? (
                      <FilePicker
                        label={`Replace photo ${slot} of ${name}`}
                        text="Replace"
                        icon={<RefreshCw aria-hidden className="size-4" />}
                        busy={busy === `replace-${slot}`}
                        disabled={Boolean(busy)}
                        onFile={(file) =>
                          void run(
                            `replace-${slot}`,
                            () => saveMeasurementPhoto(target, file, { photoId: photo.id, version: photo.version }),
                            `Photo ${slot} replaced on ${trail}.`,
                          )
                        }
                      />
                    ) : null}
                    {canRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={Boolean(busy)}
                        aria-label={`Remove photo ${slot} of ${name}`}
                        onClick={() => {
                          if (!window.confirm(`Remove this photo from ${trail}? Other configurations keep theirs.`)) return;
                          void run(
                            `remove-${slot}`,
                            async () => (await removeMeasurementPhoto(photo.id, photo.version)).error ?? null,
                            `Photo ${slot} removed from ${trail}.`,
                          );
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" />
                        Remove
                      </Button>
                    ) : null}
                    {canAdd && photo.inherited && photo.outdated && photos.length >= MAX_MEASUREMENT_PHOTOS && slot === firstOutdated ? (
                      // Both slots taken: a new photo takes the place of an outdated previous-Trail photo (Migration 12).
                      <FilePicker
                        label={`Take a new photo of ${name} in place of the outdated one`}
                        text="Take new photo"
                        capture
                        icon={<Camera aria-hidden className="size-4" />}
                        busy={busy === `new-${slot}`}
                        disabled={Boolean(busy)}
                        onFile={(file) => void run(`new-${slot}`, () => saveMeasurementPhoto(target, file), `New photo added to ${trail}.`)}
                      />
                    ) : null}
                  </div>
                </>
              ) : canAdd ? (
                <div className="grid gap-2">
                  <FilePicker
                    label={`Take photo ${slot} of ${name}`}
                    text="Take photo"
                    capture
                    icon={<Camera aria-hidden className="size-4" />}
                    busy={busy === `add-${slot}`}
                    disabled={Boolean(busy)}
                    onFile={(file) => void run(`add-${slot}`, () => saveMeasurementPhoto(target, file), `Photo added to ${trail}.`)}
                  />
                  <FilePicker
                    label={`Choose photo ${slot} of ${name}`}
                    text="Choose photo"
                    icon={<ImagePlus aria-hidden className="size-4" />}
                    busy={false}
                    disabled={Boolean(busy)}
                    onFile={(file) => void run(`add-${slot}`, () => saveMeasurementPhoto(target, file), `Photo added to ${trail}.`)}
                  />
                </div>
              ) : (
                <p className="grid aspect-[4/3] place-items-center rounded-lg bg-white/[0.03] text-sm text-muted">No photo</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A button that opens the file chooser (or, with `capture`, the phone's camera). Images only. */
function FilePicker({
  label,
  text,
  icon,
  capture = false,
  busy,
  disabled,
  onFile,
}: {
  label: string;
  text: string;
  icon: React.ReactNode;
  capture?: boolean;
  busy: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" as const } : {})}
        className="sr-only"
        tabIndex={-1}
        aria-label={`${label} (file)`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => input.current?.click()} aria-label={label}>
        {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : icon}
        {busy ? "Saving…" : text}
      </Button>
    </>
  );
}
