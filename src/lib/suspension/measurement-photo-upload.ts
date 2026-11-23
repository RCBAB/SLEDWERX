import { addMeasurementPhoto, prepareMeasurementPhoto, replaceMeasurementPhoto } from "@/app/garage/suspension-actions";
import { PhotoError } from "@/lib/sleds/photo-upload";

import { discardSuspensionPhoto, uploadSuspensionPhoto } from "./photo-upload";

/** Messages after which trying the save again can't help. */
const FINAL = [
  "At most 2 photos",
  "Only the owner or an editor",
  "Restore it before",
  "That photo",
  "Photo not found",
  "You can't",
  "This photo",
];

export type MeasurementPhotoTarget = { sledId: string; revisionId: string; settingId: string };

/**
 * Add a measurement photo to one configuration, or replace one of its photos
 * (`replace`), with the same safety steps as the other suspension photos:
 *
 * 1. The server checks the configuration and setting still exist, the user's
 *    permission and the 2-photo limit BEFORE anything is uploaded.
 * 2. The image is checked and resized in the browser (JPEG, longest side
 *    1600 px, no location data); a file that isn't an image is never sent.
 * 3. A NEW file is uploaded into the configuration's folder (files are never
 *    overwritten: other configurations may share the old one), then recorded.
 *    A failed save is tried once more (a repeat is recognised).
 * 4. If the record still can't be saved, owners and editors remove the new
 *    file again; a mechanic's stays unlisted for the Migration 8 cleanup.
 *
 * Returns an error message to show, or null when saved.
 */
export async function saveMeasurementPhoto(
  target: MeasurementPhotoTarget,
  file: File,
  replace?: { photoId: string; version: number },
): Promise<string | null> {
  const { sledId, revisionId, settingId } = target;
  const check = await prepareMeasurementPhoto(sledId, revisionId, settingId, Boolean(replace));
  if (check.error) return check.error;
  let path: string;
  try {
    path = await uploadSuspensionPhoto(sledId, revisionId, file);
  } catch (error) {
    return error instanceof PhotoError ? error.message : "The photo couldn't be uploaded. Please try again.";
  }
  const record = () =>
    replace
      ? replaceMeasurementPhoto(sledId, revisionId, replace.photoId, replace.version, path)
      : addMeasurementPhoto(sledId, revisionId, settingId, path);
  let saved = await record().catch(() => ({ error: "Something went wrong. Please try again." }) as { error?: string; ok?: boolean });
  if (saved.error && !FINAL.some((m) => saved.error!.startsWith(m))) {
    saved = await record().catch(() => ({ error: "Something went wrong. Please try again." }));
    // A replace that went through the first time: the old photo is already replaced.
    if (replace && saved.error === "Photo not found.") saved = { ok: true };
  }
  if (saved.error) {
    if (check.canRemoveFiles) await discardSuspensionPhoto(path);
    return saved.error;
  }
  return null;
}
