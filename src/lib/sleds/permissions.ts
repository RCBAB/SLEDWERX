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
  };
}

/** Owners and editors can fix any reading; mechanics only readings they added. */
export function canFixReading(role: SledRole, readingCreatedBy: string | null, userId: string): boolean {
  if (role === "owner" || role === "editor") return true;
  return role === "mechanic" && readingCreatedBy === userId;
}

export const ROLE_LABELS: Record<SledRole, string> = {
  owner: "Owner",
  editor: "Editor",
  mechanic: "Mechanic",
  viewer: "Viewer",
};
