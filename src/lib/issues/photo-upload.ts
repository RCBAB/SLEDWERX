import { PhotoError, resizePhoto } from "@/lib/sleds/photo-upload";
import { createClient } from "@/lib/supabase/client";
import { randomUuid } from "@/lib/uuid";

import { ISSUE_PHOTO_BUCKET } from "./types";

/**
 * Resizes (longest side 1600 px, JPEG, no GPS data) and uploads an issue photo
 * with the signed-in user's session, into the issue's own folder. Storage
 * policies allow this only for people who may edit the issue. Returns the path.
 */
export async function uploadIssuePhoto(sledId: string, issueId: string, file: File): Promise<string> {
  const blob = await resizePhoto(file);
  const path = `${sledId}/${issueId}/${randomUuid()}.jpg`;
  const { error } = await createClient()
    .storage.from(ISSUE_PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (error) throw new PhotoError("A photo couldn't be uploaded. Please try again.");
  return path;
}

export { PhotoError };
