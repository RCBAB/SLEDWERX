import "server-only";

/**
 * Feature flag: suspension reference and adjustment photo uploads (Phase 6.2).
 *
 * OFF unless the server-only environment variable SUSPENSION_PHOTO_UPLOADS is
 * exactly "on". While off, the interface offers no way to add suspension
 * photos and the server actions refuse to prepare or record one; photos that
 * already exist stay visible and can still be removed by owners and editors.
 *
 * Read at request time (never inlined into the browser bundle), so turning
 * uploads on later is a configuration change plus a redeploy, with no code
 * change. Approved release decision (Decision 10, amended): uploads stay off
 * until Migration 8 cleanup has been verified in deletion mode.
 */
export function suspensionPhotoUploadsEnabled(): boolean {
  return process.env.SUSPENSION_PHOTO_UPLOADS === "on";
}
