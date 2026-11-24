import "server-only";

/**
 * Feature flag: suspension measurement photo uploads (Phase 6.2).
 *
 * OFF unless the server-only environment variable SUSPENSION_PHOTO_UPLOADS is
 * exactly "on". While off, the interface offers no way to add suspension
 * photos and the server actions refuse to prepare or record one; photos that
 * already exist stay visible and can still be removed by owners and editors.
 *
 * Read at request time (never inlined into the browser bundle), so turning
 * uploads on or off is a configuration change plus a redeploy, with no code
 * change. Only measurement photos are added from the app; reference and
 * adjustment photo uploads stay off in the code. On in production since
 * 2026-11-24, independent of the Migration 8 cleanup's deletion (Decision 10,
 * amended again 2026-11-24). While off, Photo Needed reminders are hidden.
 */
export function suspensionPhotoUploadsEnabled(): boolean {
  return process.env.SUSPENSION_PHOTO_UPLOADS === "on";
}
