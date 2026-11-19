/** Suspension setup & tuning (Phase 6.2, Migration 7). */

/** The seven zones of the sled diagram, front to rear (the order used everywhere). */
export const SUSPENSION_ZONES = [
  "front_left_shock",
  "front_right_shock",
  "front_general",
  "rear_front_shock",
  "rear_rear_shock",
  "rear_springs_limiter",
  "rear_general",
] as const;
export type SuspensionZone = (typeof SUSPENSION_ZONES)[number];

export const ZONE_LABEL: Record<SuspensionZone, string> = {
  front_left_shock: "Left ski shock",
  front_right_shock: "Right ski shock",
  front_general: "Front general",
  rear_front_shock: "Front track shock",
  rear_rear_shock: "Rear track shock",
  rear_springs_limiter: "Springs & limiter strap",
  rear_general: "Rear general",
};

export const ZONE_GROUPS: readonly { id: "front" | "rear"; label: string; zones: readonly SuspensionZone[] }[] = [
  { id: "front", label: "Front", zones: ["front_left_shock", "front_right_shock", "front_general"] },
  { id: "rear", label: "Rear", zones: ["rear_front_shock", "rear_rear_shock", "rear_springs_limiter", "rear_general"] },
];

export function isZone(value: unknown): value is SuspensionZone {
  return typeof value === "string" && (SUSPENSION_ZONES as readonly string[]).includes(value);
}

export const VALUE_TYPES = ["number", "text"] as const;
export type SettingValueType = (typeof VALUE_TYPES)[number];
export const VALUE_TYPE_LABEL: Record<SettingValueType, string> = { number: "Number", text: "Text" };

/** Suggestions for the unit field only. Never settings, never values. */
export const UNIT_SUGGESTIONS = ["Clicks", "Turns", "mm", "in", "PSI"] as const;

export const FEEDBACK_RATINGS = ["improved", "worse", "no_change"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const FEEDBACK_LABEL: Record<FeedbackRating, string> = { improved: "Improved", worse: "Worse", no_change: "No change" };

export const MAX_SUSPENSION_PHOTOS = 6;
export const SUSPENSION_PHOTO_BUCKET = "suspension-photos";
/** Longest value the database accepts. */
export const MAX_SETTING_VALUE = 200;
/** Restores are allowed this long after a delete (private.recovery_window()). */
export const RECOVERY_DAYS = 30;

export type SuspensionPhoto = { id: string; path: string; url: string | null; version: number; createdBy: string | null };

export type SuspensionSetting = {
  id: string;
  name: string;
  zone: SuspensionZone;
  valueType: SettingValueType;
  unit: string | null;
  position: number;
  notes: string | null;
  version: number;
  photos: SuspensionPhoto[];
};

/** One setting in a revision snapshot (names and units as they were then). */
export type SnapshotEntry = { value: string; name: string; zone: SuspensionZone; unit: string | null; type: SettingValueType };
/** A revision's values, keyed by setting id. Blank settings are absent. */
export type Snapshot = Record<string, SnapshotEntry>;

export type SuspensionFeedback = {
  id: string;
  revisionId: string;
  riddenOn: string;
  rating: FeedbackRating;
  note: string | null;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
};

export type SuspensionRevision = {
  id: string;
  setupId: string;
  number: number;
  values: Snapshot;
  note: string | null;
  odometer: number | null;
  engineHours: number | null;
  restoredFrom: { id: string; number: number } | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string;
  /** Newest first. */
  feedback: SuspensionFeedback[];
  photos: SuspensionPhoto[];
};

export type SuspensionSetup = {
  id: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
};

export type DeletedSuspensionItem = {
  kind: "setup" | "setting";
  id: string;
  name: string;
  detail: string | null;
  deletedAt: string;
  /** Whole days left to restore it (worked out when the page was loaded). */
  daysLeft: number;
  version: number;
};

/** Everything the Suspension page shows for one sled. */
export type SuspensionData = {
  sledId: string;
  settings: SuspensionSetting[];
  setups: SuspensionSetup[];
  /** Every revision on the sled (all setups), newest first. */
  revisions: SuspensionRevision[];
  /** Recently Deleted setups and settings (owners and editors only), newest first. */
  deleted: DeletedSuspensionItem[];
};

/** The active setup at a glance (sled page and Garage Board). */
export type ActiveSuspension = {
  setupId: string;
  setupName: string;
  revisionId: string;
  revisionNumber: number;
  changedAt: string;
  values: Snapshot;
  latestFeedback: { rating: FeedbackRating; riddenOn: string } | null;
  settings: SuspensionSetting[];
};

/** Settings in diagram order: zone, then position, then name. */
export function sortSettings<T extends Pick<SuspensionSetting, "zone" | "position" | "name">>(settings: T[]): T[] {
  return [...settings].sort(
    (a, b) =>
      SUSPENSION_ZONES.indexOf(a.zone) - SUSPENSION_ZONES.indexOf(b.zone) ||
      a.position - b.position ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function settingsInZone<T extends Pick<SuspensionSetting, "zone" | "position" | "name">>(settings: T[], zone: SuspensionZone): T[] {
  return sortSettings(settings.filter((s) => s.zone === zone));
}

/** The latest revision of a setup (revisions newest first, or any order). */
export function latestRevision(revisions: SuspensionRevision[], setupId: string): SuspensionRevision | undefined {
  let latest: SuspensionRevision | undefined;
  for (const r of revisions) if (r.setupId === setupId && (!latest || r.number > latest.number)) latest = r;
  return latest;
}

/** Whether a deleted item can still be restored (30 days from its delete). */
export function isRestorable(deletedAt: string, now = new Date()): boolean {
  return now.getTime() - new Date(deletedAt).getTime() < RECOVERY_DAYS * 24 * 60 * 60 * 1000;
}

/** Whole days left to restore an item (at least 0). */
export function daysLeftToRestore(deletedAt: string, now = new Date()): number {
  const left = RECOVERY_DAYS * 24 * 60 * 60 * 1000 - (now.getTime() - new Date(deletedAt).getTime());
  return Math.max(0, Math.ceil(left / (24 * 60 * 60 * 1000)));
}

/** The revision saved just before this one in the same setup, if any. */
export function previousRevision(revisions: SuspensionRevision[], revision: SuspensionRevision): SuspensionRevision | undefined {
  let previous: SuspensionRevision | undefined;
  for (const r of revisions)
    if (r.setupId === revision.setupId && r.number < revision.number && (!previous || r.number > previous.number)) previous = r;
  return previous;
}

/** The values of a revision that still have a setting on the sled (what a restore or copy brings back). */
export function restorableValues(values: Snapshot, settings: Pick<SuspensionSetting, "id">[]): Snapshot {
  const ids = new Set(settings.map((s) => s.id));
  return Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id)));
}
