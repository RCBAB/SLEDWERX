import type { SledRole } from "./constants";

/**
 * What the interface offers for a sled. These mirror the database rules
 * (Migration 1 roles); Row Level Security still enforces them on every query.
 */
export function sledCapabilities(role: SledRole) {
  const manages = role === "owner" || role === "editor";
  return {
    canEdit: manages,
    canChangePhoto: manages,
    canAddReading: manages || role === "mechanic",
    canRemoveReading: manages,
    canLogService: manages || role === "mechanic",
    canManageSledTasks: manages,
  };
}

/** Owners and editors can fix any reading; mechanics only readings they added. */
export function canFixReading(role: SledRole, readingCreatedBy: string | null, userId: string): boolean {
  if (role === "owner" || role === "editor") return true;
  return role === "mechanic" && readingCreatedBy === userId;
}

/**
 * What the interface offers for one service record. Owners and editors can
 * change any record; a mechanic only records they created (including adding,
 * editing and removing its parts and tasks, and correcting its mileage).
 * Only owners and editors can delete a record or remove its mileage.
 */
export function serviceCapabilities(role: SledRole, recordCreatedBy: string | null, userId: string) {
  const manages = role === "owner" || role === "editor";
  return {
    canEdit: manages || (role === "mechanic" && recordCreatedBy === userId),
    canDelete: manages,
    canRemoveMileage: manages,
  };
}

/**
 * What the interface offers for suspension tuning (Phase 6.2). Mirrors the
 * Migration 7 rules; Row Level Security and the database triggers enforce them.
 * - Owners and editors manage setups and the settings list, add reference
 *   photos, remove feedback and photos, and restore from Recently Deleted.
 * - Mechanics record adjustments, restore revisions, add feedback and
 *   adjustment photos, and edit their own feedback.
 * - Viewers only read.
 *
 * Adding photos also needs the photo-upload feature flag (server-only
 * SUSPENSION_PHOTO_UPLOADS, see lib/suspension/photo-flag.ts). It defaults to
 * off here, so a caller that doesn't pass it never offers uploads.
 */
export function suspensionCapabilities(role: SledRole, { photoUploads = false }: { photoUploads?: boolean } = {}) {
  const manages = role === "owner" || role === "editor";
  const adjusts = manages || role === "mechanic";
  return {
    canManage: manages,
    canAdjust: adjusts,
    canAddFeedback: adjusts,
    // Reference and adjustment photos (Migration 7) are no longer added, even
    // with photo uploads on: measurement photos replace them. Existing ones
    // can still be viewed, and removed by owners and editors.
    canAddReferencePhotos: false,
    canAddAdjustmentPhotos: false,
    /** Measurement photos (Migration 10): add (owners, editors, mechanics), replace (owners, editors). */
    canAddMeasurementPhotos: adjusts && photoUploads,
    canReplaceMeasurementPhotos: manages && photoUploads,
    canRemove: manages,
  };
}

/** Owners and editors can edit any feedback; mechanics only their own. */
export function canEditSuspensionFeedback(role: SledRole, createdBy: string | null, userId: string): boolean {
  return serviceCapabilities(role, createdBy, userId).canEdit;
}

export const ROLE_LABELS: Record<SledRole, string> = {
  owner: "Owner",
  editor: "Editor",
  mechanic: "Mechanic",
  viewer: "Viewer",
};
