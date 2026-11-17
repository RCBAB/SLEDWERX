import { createClient } from "@/lib/supabase/client";
import { randomUuid } from "@/lib/uuid";

import { PHOTO_BUCKET, PHOTO_MAX_DIMENSION, PHOTO_MAX_INPUT_BYTES } from "./constants";

/** A problem with a photo that can be shown to the user as-is. */
export class PhotoError extends Error {}

// The bucket accepts up to 5 MB; stay well under it.
const TARGET_BYTES = 4 * 1024 * 1024;

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * Shrinks a photo in the browser to at most 1600 px on its longest side and
 * re-encodes it as JPEG. This also drops EXIF data such as GPS location.
 */
export async function resizePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new PhotoError("Choose an image file, such as a JPEG or PNG.");
  }
  if (file.size > PHOTO_MAX_INPUT_BYTES) {
    throw new PhotoError("That photo is too large. Choose one under 25 MB.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoError("This photo couldn't be read. Try a JPEG or PNG.");
  }

  const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new PhotoError("This browser can't prepare photos for upload.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await toJpeg(canvas, quality);
    if (blob && blob.size <= TARGET_BYTES) return blob;
  }
  throw new PhotoError("This photo couldn't be made small enough to upload.");
}

/**
 * Resizes and uploads a sled photo with the signed-in user's session. Storage
 * policies allow this only for the sled's owner and editors. Returns the
 * object path to save on the sled.
 */
export async function uploadSledPhoto(sledId: string, file: File): Promise<string> {
  const blob = await resizePhoto(file);
  const path = `${sledId}/${randomUuid()}.jpg`;
  const { error } = await createClient()
    .storage.from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (error) throw new PhotoError("The photo couldn't be uploaded. Please try again.");
  return path;
}

/** Removes a photo that was uploaded but never saved on the sled. */
export async function discardUploadedPhoto(path: string) {
  try {
    await createClient().storage.from(PHOTO_BUCKET).remove([path]);
  } catch {
    // Best effort: an unused file is only visible to the sled's users.
  }
}
