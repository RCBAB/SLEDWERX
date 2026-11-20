import { addSuspensionPhoto, prepareSuspensionPhotos } from "@/app/garage/suspension-actions";
import { PhotoError, resizePhoto } from "@/lib/sleds/photo-upload";
import { createClient } from "@/lib/supabase/client";
import { randomUuid } from "@/lib/uuid";

import { MAX_SUSPENSION_PHOTOS, SUSPENSION_PHOTO_BUCKET } from "./types";

export type PhotoParent = { kind: "setting" | "revision"; id: string };

/**
 * Resizes (longest side 1600 px, JPEG, no GPS data) and uploads a suspension
 * photo with the signed-in user's session into its parent's folder: a setting
 * (reference photo) or a revision (adjustment photo). Storage policies allow
 * reference photos for owners and editors, adjustment photos also for
 * mechanics. Returns the path.
 */
export async function uploadSuspensionPhoto(sledId: string, parentId: string, file: File): Promise<string> {
  const blob = await resizePhoto(file);
  const path = `${sledId}/${parentId}/${randomUuid()}.jpg`;
  const { error } = await createClient()
    .storage.from(SUSPENSION_PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (error) throw new PhotoError("A photo couldn't be uploaded. Please try again.");
  return path;
}

/** Best effort: removes a file whose photo record couldn't be saved (owners and editors only, by storage policy). */
export async function discardSuspensionPhoto(path: string): Promise<void> {
  await createClient()
    .storage.from(SUSPENSION_PHOTO_BUCKET)
    .remove([path])
    .catch(() => undefined);
}

export type PhotoUploadResult = {
  added: number;
  /** Why the rest wasn't added, ready to show. */
  error: string | null;
  /** Files that were uploaded but couldn't be recorded or removed (mechanics; see below). */
  leftover: number;
};

/** Messages after which trying again can't help. */
const FINAL = [
  "At most 6 photos",
  "Only the owner or an editor",
  "Restore it before",
  "That photo is not in the right folder",
  "Photo not found",
  "That photo can't be used",
  "You don't have permission",
];

/**
 * Adds photos to a setting or revision, one by one, so a failure never
 * leaves a record without a file and almost never a file without a record:
 *
 * 1. Before anything is uploaded, the server checks the parent still exists,
 *    the user may add this kind of photo, and how many more fit (6 at most).
 *    Files that don't fit are not uploaded at all.
 * 2. Each photo is resized in the browser first; if that fails, nothing has
 *    been uploaded.
 * 3. The file is uploaded, then its record is saved. A failed save is tried
 *    once more (a repeat of a save that did succeed is recognised).
 * 4. If the record still can't be saved, the file is removed again when the
 *    user may remove files (owners and editors). Mechanics can't remove files
 *    (storage policy), so such a file stays, unlisted and unreachable from
 *    the app; it is counted in `leftover` and reported.
 */
export async function addSuspensionPhotos(sledId: string, parent: PhotoParent, files: File[]): Promise<PhotoUploadResult> {
  if (!files.length) return { added: 0, error: null, leftover: 0 };
  const check = await prepareSuspensionPhotos(sledId, parent);
  if (check.error) return { added: 0, error: check.error, leftover: 0 };
  const take = files.slice(0, check.room);
  const existing = MAX_SUSPENSION_PHOTOS - check.room;
  let added = 0;
  let leftover = 0;

  for (const [n, file] of take.entries()) {
    let path: string;
    try {
      path = await uploadSuspensionPhoto(sledId, parent.id, file);
    } catch (error) {
      return { added, leftover, error: error instanceof PhotoError ? error.message : "A photo couldn't be uploaded. Please try again." };
    }
    let saved = await addSuspensionPhoto(sledId, parent, path, existing + n);
    if (saved.error && !FINAL.some((m) => saved.error!.startsWith(m))) {
      saved = await addSuspensionPhoto(sledId, parent, path, existing + n);
      // The first save went through after all (same path).
      if (saved.error === "That was already saved.") saved = { ok: true };
    }
    if (saved.error) {
      if (check.canRemoveFiles) await discardSuspensionPhoto(path);
      else leftover += 1;
      return { added, leftover, error: saved.error };
    }
    added += 1;
  }

  const skipped = files.length - take.length;
  return {
    added,
    leftover,
    error: skipped
      ? check.room
        ? `Only ${check.room} more photo${check.room === 1 ? "" : "s"} fit here (${MAX_SUSPENSION_PHOTOS} at most); ${skipped} weren't added.`
        : `This already has ${MAX_SUSPENSION_PHOTOS} photos.`
      : null,
  };
}

export { PhotoError };
