import { PhotoError, resizePhoto } from "@/lib/sleds/photo-upload";
import { createClient } from "@/lib/supabase/client";
import { randomUuid } from "@/lib/uuid";

import { SUSPENSION_PHOTO_BUCKET } from "./types";

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

/** Best effort: removes a file whose photo record couldn't be saved (owners and editors only, by policy). */
export async function discardSuspensionPhoto(path: string): Promise<void> {
  await createClient().storage.from(SUSPENSION_PHOTO_BUCKET).remove([path]).catch(() => undefined);
}

export { PhotoError };
