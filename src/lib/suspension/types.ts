/** Suspension setup & tuning (Phase 6.2, Migration 7). */

import type { TrailTurnsMap } from "./turns";

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

/** How a setting is adjusted (Migration 12). Turns need a number setting. Existing settings are measurement only. */
export const INPUT_METHODS = ["measurement", "turns", "both"] as const;
export type InputMethods = (typeof INPUT_METHODS)[number];
export const INPUT_METHOD_LABEL: Record<InputMethods, string> = {
  measurement: "Measurement only",
  turns: "Turns only",
  both: "Measurement and Turns",
};
export function isInputMethods(value: unknown): value is InputMethods {
  return typeof value === "string" && (INPUT_METHODS as readonly string[]).includes(value);
}
/** Whether a setting has a measurement (and so a measurement unit). */
export function measures(methods: InputMethods): boolean {
  return methods !== "turns";
}
/** Turns only and Measurement and Turns can be chosen (Quick Tune supports turns). */
export const TURNS_INPUT_AVAILABLE = true;

/** Suggestions for the unit field only. Never settings, never values. */
export const UNIT_SUGGESTIONS = ["Clicks", "Turns", "mm", "in", "PSI"] as const;

/** Ride evaluation ratings (Migration 9). */
export const RIDE_RATINGS = ["liked", "neutral", "disliked"] as const;
export type RideRating = (typeof RIDE_RATINGS)[number];
/** Ratings of feedback saved before Migration 9 (kept and shown as they were). */
export const LEGACY_RATINGS = ["improved", "worse", "no_change"] as const;
export const FEEDBACK_RATINGS = [...RIDE_RATINGS, ...LEGACY_RATINGS] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const FEEDBACK_LABEL: Record<FeedbackRating, string> = {
  liked: "Liked",
  neutral: "Neutral / needs more testing",
  disliked: "Disliked",
  improved: "Improved",
  worse: "Worse",
  no_change: "No change",
};
/** Short labels for badges. */
export const FEEDBACK_SHORT: Record<FeedbackRating, string> = { ...FEEDBACK_LABEL, neutral: "Neutral" };
export function isRideRating(value: unknown): value is RideRating {
  return typeof value === "string" && (RIDE_RATINGS as readonly string[]).includes(value);
}

export const TRAIL_CONDITIONS = ["loose_snow", "hard_pack", "perfect_groomed", "sloppy", "fresh_snow"] as const;
export type TrailCondition = (typeof TRAIL_CONDITIONS)[number];
export const CONDITION_LABEL: Record<TrailCondition, string> = {
  loose_snow: "Loose Snow",
  hard_pack: "Hard Pack",
  perfect_groomed: "Perfect Groomed",
  sloppy: "Sloppy",
  fresh_snow: "Fresh Snow",
};
export function isTrailCondition(value: unknown): value is TrailCondition {
  return typeof value === "string" && (TRAIL_CONDITIONS as readonly string[]).includes(value);
}

/** Skis and carbides (Migration 9). */
export const SKI_MODELS = ["ca_pro_xpt", "ca_pro_xcs"] as const;
export type SkiModel = (typeof SKI_MODELS)[number];
export const SKI_LABEL: Record<SkiModel, string> = { ca_pro_xpt: "C&A Pro XPT", ca_pro_xcs: "C&A Pro XCS" };
export const SKI_SHORT: Record<SkiModel, string> = { ca_pro_xpt: "XPT", ca_pro_xcs: "XCS" };
export const CARBIDE_LENGTHS = ["6", "7.5", "9"] as const;
export type CarbideLength = (typeof CARBIDE_LENGTHS)[number];
export const carbideLabel = (length: CarbideLength) => `${length}"`;
export function isSkiModel(value: unknown): value is SkiModel {
  return typeof value === "string" && (SKI_MODELS as readonly string[]).includes(value);
}
export function isCarbideLength(value: unknown): value is CarbideLength {
  return typeof value === "string" && (CARBIDE_LENGTHS as readonly string[]).includes(value);
}
/** Skis and carbides; null = not recorded. */
export type Equipment = { ski: SkiModel | null; carbide: CarbideLength | null };
export const NO_EQUIPMENT: Equipment = { ski: null, carbide: null };

/** "C&A Pro XPT · 7.5\" carbides", or what's missing. */
export function describeEquipment(equipment: Equipment): string {
  if (!equipment.ski && !equipment.carbide) return "Not recorded";
  const ski = equipment.ski ? SKI_LABEL[equipment.ski] : "Skis not recorded";
  const carbide = equipment.carbide ? `${carbideLabel(equipment.carbide)} carbides` : "carbides not recorded";
  return `${ski} · ${carbide}`;
}

export function sameEquipment(a: Equipment, b: Equipment): boolean {
  return a.ski === b.ski && a.carbide === b.carbide;
}

/**
 * Whether a configuration needs equipment other than what is installed (only
 * what it recorded counts: "not recorded" never conflicts).
 */
export function equipmentMismatch(required: Equipment, installed: Equipment): boolean {
  return Boolean((required.ski && required.ski !== installed.ski) || (required.carbide && required.carbide !== installed.carbide));
}

/** Numbered configurations are shown as "Trail N". */
export const configName = (number: number) => `Trail ${number}`;

export const MAX_SUSPENSION_PHOTOS = 6;
/** Measurement photos per setting per configuration (Migration 10). */
export const MAX_MEASUREMENT_PHOTOS = 2;
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
  /** Measurement only, Turns only, or both (Migration 12; measurement before it). */
  inputMethods: InputMethods;
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
  conditions: TrailCondition[];
  /** Day's high temperature, degF. */
  highTempF: number | null;
  note: string | null;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
};

/**
 * A photo documenting one measurement (setting) on one configuration
 * (Migration 10). The file may be shared with other configurations; the row
 * is this configuration's own.
 */
export type MeasurementPhoto = {
  id: string;
  revisionId: string;
  settingId: string;
  slot: 1 | 2;
  path: string;
  url: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  /** Carried forward from an earlier Trail (a reference copy, not newly captured). */
  inherited: boolean;
  /** Carried forward for a setting whose value changed since (Migration 12). */
  outdated: boolean;
};

/** A numbered configuration ("Trail N"): one saved revision of the sled's suspension. */
export type SuspensionRevision = {
  id: string;
  setupId: string;
  /** Revision number within its setup (Migration 7). */
  number: number;
  /** Sled-wide configuration number: "Trail N". */
  configNumber: number;
  equipment: Equipment;
  /** The configuration this one was made from (if recorded). */
  basedOnId: string | null;
  /** Its actual values: as saved, with a measurement documented later on this Trail in place of the blank turned value. */
  values: Snapshot;
  /** What it shows: values, plus outstanding turns as "+2.5 turns" (View, History, Compare, warnings). */
  display: Snapshot;
  /** Turns-tracked settings on this Trail (Migration 12). */
  turns: TrailTurnsMap;
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
  /** Measurement photos of this configuration, by slot. */
  measurementPhotos: MeasurementPhoto[];
};

export type SuspensionSetup = { id: string; name: string; notes: string | null; isActive: boolean; version: number; createdAt: string };

export type DeletedSuspensionItem = {
  kind: "setup" | "setting" | "feedback";
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
  /** Every configuration on the sled, newest first. */
  revisions: SuspensionRevision[];
  /** The active configuration (null before the first save). */
  activeRevisionId: string | null;
  /** The skis and carbides installed now. */
  installed: Equipment;
  /** Whether the database has measurement photos (Migration 10). */
  measurementPhotos: boolean;
  /** Recently Deleted setups, settings and feedback (owners and editors only), newest first. */
  deleted: DeletedSuspensionItem[];
};

/** A sled's suspension at a glance (sled page and Garage Board). */
export type ActiveSuspension = {
  /** The active configuration, if one has been saved. */
  active: {
    revisionId: string;
    configNumber: number;
    changedAt: string;
    values: Snapshot;
    display: Snapshot;
    turns: TrailTurnsMap;
    equipment: Equipment;
    latestFeedback: { rating: FeedbackRating; riddenOn: string; conditions: TrailCondition[] } | null;
  } | null;
  installed: Equipment;
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
