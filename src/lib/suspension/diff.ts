import {
  SUSPENSION_ZONES,
  type FeedbackRating,
  type Snapshot,
  type SnapshotEntry,
  type SuspensionFeedback,
  type SuspensionSetting,
  type SuspensionZone,
} from "./types";

/** "10 clicks", "2.5 Turns", "Stiff spring" (text values carry no unit). */
export function formatValue(value: string | null | undefined, unit: string | null | undefined, type?: string): string {
  if (value == null || value === "") return "—";
  if (type === "text" || !unit) return value;
  return `${value} ${unit}`;
}

export type ValueChange = {
  settingId: string;
  name: string;
  zone: SuspensionZone;
  unit: string | null;
  type: SnapshotEntry["type"];
  before: string | null;
  after: string | null;
  kind: "changed" | "added" | "cleared";
};

const zoneIndex = (zone: SuspensionZone) => SUSPENSION_ZONES.indexOf(zone);

/** Orders rows like the diagram: zone, then the setting's current position, then name. */
function byDiagram(settings: Pick<SuspensionSetting, "id" | "position">[]) {
  const position = new Map(settings.map((s) => [s.id, s.position]));
  return (a: { settingId: string; zone: SuspensionZone; name: string }, b: { settingId: string; zone: SuspensionZone; name: string }) =>
    zoneIndex(a.zone) - zoneIndex(b.zone) ||
    (position.get(a.settingId) ?? 9999) - (position.get(b.settingId) ?? 9999) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * What changed from one revision to the next (or from nothing, for the first).
 * Unchanged settings are left out.
 */
export function revisionChanges(
  previous: Snapshot | null | undefined,
  current: Snapshot,
  settings: Pick<SuspensionSetting, "id" | "position">[] = [],
): ValueChange[] {
  const before = previous ?? {};
  const ids = new Set([...Object.keys(before), ...Object.keys(current)]);
  const changes: ValueChange[] = [];
  for (const id of ids) {
    const a = before[id];
    const b = current[id];
    if (a && b && a.value === b.value) continue;
    const entry = (b ?? a)!;
    changes.push({
      settingId: id,
      name: entry.name,
      zone: entry.zone,
      unit: entry.unit,
      type: entry.type,
      before: a?.value ?? null,
      after: b?.value ?? null,
      kind: a && b ? "changed" : b ? "added" : "cleared",
    });
  }
  return changes.sort(byDiagram(settings));
}

/** "Rebound: 8 → 10 clicks", "Spring: set to Stiff", "Preload: cleared (was 3 turns)". */
export function describeChange(change: ValueChange): string {
  const unit = change.type === "text" ? null : change.unit;
  if (change.kind === "added") return `${change.name}: set to ${formatValue(change.after, unit)}`;
  if (change.kind === "cleared") return `${change.name}: cleared (was ${formatValue(change.before, unit)})`;
  const before = unit && change.before != null ? change.before : formatValue(change.before, null);
  return `${change.name}: ${before} → ${formatValue(change.after, unit)}`;
}

export type ComparisonRow = {
  settingId: string;
  name: string;
  zone: SuspensionZone;
  unit: string | null;
  type: SnapshotEntry["type"];
  a: string | null;
  b: string | null;
  changed: boolean;
};

/**
 * Two revisions side by side (any setups of the same sled). Every setting that
 * has a value in either is listed; `changed` marks the ones that differ.
 * Names and units come from the newer snapshot ("b") where it has the setting.
 */
export function compareSnapshots(a: Snapshot, b: Snapshot, settings: Pick<SuspensionSetting, "id" | "position">[] = []): ComparisonRow[] {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows: ComparisonRow[] = [];
  for (const id of ids) {
    const entry = (b[id] ?? a[id])!;
    const av = a[id]?.value ?? null;
    const bv = b[id]?.value ?? null;
    rows.push({ settingId: id, name: entry.name, zone: entry.zone, unit: entry.unit, type: entry.type, a: av, b: bv, changed: av !== bv });
  }
  return rows.sort(byDiagram(settings));
}

/**
 * The changes to send when saving an adjustment: only settings whose new value
 * differs from the current one. A cleared value is sent as null.
 */
export function changedValues(current: Snapshot, edited: Record<string, string | null>): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(edited)) {
    const now = current[id]?.value ?? null;
    const next = value === "" ? null : value;
    if (now !== next) changes[id] = next;
  }
  return changes;
}

/** The newest feedback entry (by ride date, then when it was added). */
export function latestFeedback<T extends Pick<SuspensionFeedback, "riddenOn" | "createdAt">>(feedback: T[]): T | undefined {
  return [...feedback].sort((x, y) => y.riddenOn.localeCompare(x.riddenOn) || y.createdAt.localeCompare(x.createdAt))[0];
}

export const RATING_TONE: Record<FeedbackRating, "good" | "bad" | "neutral"> = {
  improved: "good",
  worse: "bad",
  no_change: "neutral",
};

/** Number of settings with a value in each zone. */
export function valuesPerZone(values: Snapshot): Record<SuspensionZone, number> {
  const counts = Object.fromEntries(SUSPENSION_ZONES.map((z) => [z, 0])) as Record<SuspensionZone, number>;
  for (const entry of Object.values(values)) counts[entry.zone] += 1;
  return counts;
}
