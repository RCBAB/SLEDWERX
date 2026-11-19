"use client";

import { Camera, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { removeSuspensionPhoto } from "@/app/garage/suspension-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { addSuspensionPhotos, type PhotoParent } from "@/lib/suspension/photo-upload";
import { MAX_SUSPENSION_PHOTOS, type SuspensionPhoto } from "@/lib/suspension/types";

import { useRun } from "./shared";

/** Saved photos as thumbnails (each opens the full photo); owners and editors can remove them. */
export function PhotoGrid({
  photos,
  label,
  canRemove,
  size = "md",
}: {
  photos: SuspensionPhoto[];
  /** What the photos are of, for their alt text ("Rev 4", "Compression"). */
  label: string;
  canRemove: boolean;
  size?: "sm" | "md";
}) {
  const { busy, error, run } = useRun();
  if (!photos.length) return null;
  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul
        className={cn("grid gap-2", size === "sm" ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-2 sm:grid-cols-3")}
        data-testid="photo-grid"
      >
        {photos.map((photo, n) => (
          <li key={photo.id} className="relative" data-testid="photo">
            {photo.url ? (
              <a href={photo.url} target="_blank" rel="noreferrer" className="block" aria-label={`Open photo ${n + 1} of ${label}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt={`Photo ${n + 1} of ${label}`} className="aspect-square w-full rounded-lg object-cover" />
              </a>
            ) : (
              <div className="grid aspect-square place-items-center rounded-lg bg-white/5 text-center text-xs text-muted">
                Photo unavailable
              </div>
            )}
            {canRemove ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Remove this photo?")) void run(() => removeSuspensionPhoto(photo.id, photo.version));
                }}
                aria-label={`Remove photo ${n + 1} of ${label}`}
                className="absolute right-1 top-1 grid size-11 place-items-center rounded-full bg-black/70 text-foreground hover:bg-black"
              >
                <X aria-hidden className="size-4" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Choose photos to add (previews; nothing is uploaded until the form saves). */
export function PhotoPicker({
  files,
  onChange,
  room,
  existing,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** How many more fit. */
  room: number;
  existing: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  if (room <= 0) return <p className="text-sm text-muted">This already has {MAX_SUSPENSION_PHOTOS} photos.</p>;
  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-label="Add photos"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          onChange([...files, ...picked].slice(0, room));
          event.target.value = "";
        }}
      />
      <Button type="button" variant="secondary" onClick={() => input.current?.click()} disabled={files.length >= room}>
        <Camera aria-hidden className="size-4" />
        Add photos
      </Button>
      <p className="text-sm text-muted">
        Up to {MAX_SUSPENSION_PHOTOS}
        {existing ? ` (${existing} already added)` : ""}. Photos are resized and their location data is removed before upload.
      </p>
      {files.length ? (
        <ul className="flex flex-wrap gap-2" data-testid="new-photos">
          {files.map((file, n) => (
            <PendingPhoto key={`${file.name}-${n}`} file={file} onRemove={() => onChange(files.filter((_, i) => i !== n))} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PendingPhoto({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    const timer = window.setTimeout(() => setUrl(objectUrl), 0);
    return () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);
  return (
    <li className="relative">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="size-20 rounded-lg object-cover" />
      ) : (
        <div className="size-20 rounded-lg bg-white/5" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Don't add ${file.name}`}
        className="absolute -right-2 -top-2 grid size-11 place-items-center rounded-full bg-black/80 text-foreground"
      >
        <X aria-hidden className="size-4" />
      </button>
    </li>
  );
}

/** The photo message to show after adding photos ("2 photos added", or what went wrong). */
export function photoOutcome(added: number, error: string | null, leftover: number): string | null {
  if (!error) return null;
  const done = added ? `${added} photo${added === 1 ? " was" : "s were"} added, but ` : "";
  const rest = done ? error.replace(/^\w/, (c) => c.toLowerCase()) : error;
  const note = leftover ? " The uploaded file couldn't be removed again; it isn't shown anywhere." : "";
  return `${done}${rest}${note}`;
}

/**
 * The photos of a setting (reference) or a revision (adjustment): view them,
 * and add or remove them as the user's role allows.
 */
export function PhotoManager({
  sledId,
  parent,
  label,
  photos,
  canAdd,
  canRemove,
}: {
  sledId: string;
  parent: PhotoParent;
  label: string;
  photos: SuspensionPhoto[];
  canAdd: boolean;
  canRemove: boolean;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const room = MAX_SUSPENSION_PHOTOS - photos.length;

  const upload = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await addSuspensionPhotos(sledId, parent, files);
      const problem = photoOutcome(result.added, result.error, result.leftover);
      setFiles([]);
      setMessage(
        problem
          ? { tone: "error", text: problem }
          : { tone: "success", text: `${result.added} photo${result.added === 1 ? "" : "s"} added.` },
      );
    } catch {
      setMessage({ tone: "error", text: "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="photo-manager">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {photos.length ? (
        <PhotoGrid photos={photos} label={label} canRemove={canRemove} />
      ) : (
        <p className="text-sm text-muted" data-testid="no-photos">
          No photos yet.
        </p>
      )}
      {canAdd ? (
        <div className="space-y-3 border-t border-white/10 pt-4">
          <PhotoPicker files={files} onChange={setFiles} room={room} existing={photos.length} />
          {files.length ? (
            <Button type="button" size="lg" className="w-full" onClick={() => void upload()} disabled={busy}>
              {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
              {busy ? "Uploading…" : `Upload ${files.length} photo${files.length === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
