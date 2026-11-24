/**
 * Quick Tune (Phase 6.2 redesign): the sled's settings as one list in five
 * sections, with left and right ski shocks combined where they match.
 * Pure functions, shared by the page and its tests.
 */
import { normalizeNumber } from "./validation";
import {
  ZONE_LABEL,
  previousRevision,
  settingsInZone,
  type Snapshot,
  type SuspensionRevision,
  type SuspensionSetting,
  type SuspensionZone,
} from "./types";

export const QUICK_TUNE_SECTIONS = [
  { id: "front-ski-shocks", label: "Front Ski Shocks", zones: ["front_left_shock", "front_right_shock", "front_general"] },
  { id: "front-track-shock", label: "Front Track Shock", zones: ["rear_front_shock"] },
  { id: "rear-track-shock", label: "Rear Track Shock", zones: ["rear_rear_shock"] },
  { id: "springs-limiter", label: "Springs & Limiter Strap", zones: ["rear_springs_limiter"] },
  { id: "rear-general", label: "Rear General", zones: ["rear_general"] },
] as const satisfies readonly { id: string; label: string; zones: readonly SuspensionZone[] }[];

export type QuickTuneSectionId = (typeof QUICK_TUNE_SECTIONS)[number]["id"];

/** One row of Quick Tune: a setting, or a left/right ski-shock pair adjusted together by default. */
export type QuickTuneRow =
  | { kind: "single"; key: string; setting: SuspensionSetting; label: string; side: string | null }
  | { kind: "pair"; key: string; label: string; left: SuspensionSetting; right: SuspensionSetting };

const norm = (text: string | null | undefined) => (text ?? "").trim().toLowerCase();

/** Left and right settings pair up when name, value type and unit match. */
function pairable(a: SuspensionSetting, b: SuspensionSetting) {
  return norm(a.name) === norm(b.name) && a.valueType === b.valueType && norm(a.unit) === norm(b.unit);
}

/** The rows of one section, in the settings' own order. */
export function sectionRows(settings: SuspensionSetting[], sectionId: QuickTuneSectionId): QuickTuneRow[] {
  const section = QUICK_TUNE_SECTIONS.find((s) => s.id === sectionId)!;
  if (sectionId !== "front-ski-shocks") {
    return section.zones.flatMap((zone) =>
      settingsInZone(settings, zone).map((setting) => ({
        kind: "single" as const,
        key: setting.id,
        setting,
        label: setting.name,
        side: null,
      })),
    );
  }
  const left = settingsInZone(settings, "front_left_shock");
  const right = settingsInZone(settings, "front_right_shock");
  const used = new Set<string>();
  const rows: QuickTuneRow[] = [];
  for (const l of left) {
    const r = right.find((candidate) => !used.has(candidate.id) && pairable(l, candidate));
    if (r) {
      used.add(r.id);
      rows.push({ kind: "pair", key: `${l.id}+${r.id}`, label: l.name, left: l, right: r });
    } else {
      rows.push({ kind: "single", key: l.id, setting: l, label: l.name, side: "Left" });
    }
  }
  for (const r of right) if (!used.has(r.id)) rows.push({ kind: "single", key: r.id, setting: r, label: r.name, side: "Right" });
  for (const setting of settingsInZone(settings, "front_general"))
    rows.push({ kind: "single", key: setting.id, setting, label: setting.name, side: ZONE_LABEL.front_general });
  return rows;
}

/** Units adjusted in whole steps with + and − (clicks, turns, holes, ...). Others are typed. */
const STEP_UNITS = /click|turn|hole|notch|position|pos\b|step|detent|ring/i;

export function isStepUnit(unit: string | null | undefined): boolean {
  return Boolean(unit && STEP_UNITS.test(unit));
}

/** The same number written differently ("3" and "3.0")? Non-numbers compare as text. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  const x = normalizeNumber(a);
  const y = normalizeNumber(b);
  return x !== null && y !== null ? Number(x) === Number(y) : a.trim() === b.trim();
}

/** Decimal places of a number string ("2.50" -> 2). */
const places = (value: string) => (value.includes(".") ? value.split(".")[1].length : 0);

/**
 * A value moved by a step (+1 or −1), keeping its decimals: "10" + 1 = "11",
 * "2.5" − 1 = "1.5", blank + 1 = "1". Returns null for a value that isn't a number.
 */
export function stepValue(current: string | null | undefined, delta: number): string | null {
  const base = current == null || current.trim() === "" ? "0" : normalizeNumber(current);
  if (base === null) return null;
  const decimals = places(base);
  const next = (Number(base) + delta).toFixed(decimals);
  return normalizeNumber(next);
}

/** "+2", "−1.5", or null when either value isn't a number or nothing changed. */
export function numberDelta(before: string | null | undefined, after: string | null | undefined): string | null {
  const a = before == null || before === "" ? null : normalizeNumber(before);
  const b = after == null || after === "" ? null : normalizeNumber(after);
  if (a === null || b === null) return null;
  const decimals = Math.max(places(a), places(b));
  const diff = Number(b) - Number(a);
  if (Math.abs(diff) < 1e-9) return null;
  const text = Math.abs(diff)
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `${diff > 0 ? "+" : "−"}${text}`;
}

/** Edited values, keyed by setting id ("" = cleared). */
export type PendingValues = Record<string, string>;

/** The value a setting shows: the pending edit if any, else the saved one. */
export function shownValue(pending: PendingValues, saved: Snapshot, settingId: string): string {
  return settingId in pending ? pending[settingId] : (saved[settingId]?.value ?? "");
}

/** Pending edits that differ from the saved values (normalized numbers compare equal: "10" = "10.0"). */
export function pendingChanges(pending: PendingValues, saved: Snapshot, settings: SuspensionSetting[]): Record<string, string | null> {
  const byId = new Map(settings.map((s) => [s.id, s]));
  const changes: Record<string, string | null> = {};
  for (const [id, raw] of Object.entries(pending)) {
    const setting = byId.get(id);
    if (!setting) continue;
    const text = raw.trim();
    const before = saved[id]?.value ?? null;
    if (!text) {
      if (before !== null) changes[id] = null;
      continue;
    }
    if (setting.valueType === "number") {
      const n = normalizeNumber(text);
      if (n === null) {
        changes[id] = text; // invalid: kept so the save is refused with a message
        continue;
      }
      if (before === null || !sameNumber(before, n)) changes[id] = n;
    } else if (text !== before) {
      changes[id] = text;
    }
  }
  return changes;
}

/** Setting ids whose pending number can't be saved. */
export function invalidNumbers(pending: PendingValues, settings: SuspensionSetting[]): string[] {
  return settings
    .filter((s) => s.valueType === "number" && s.id in pending && pending[s.id].trim() !== "" && normalizeNumber(pending[s.id]) === null)
    .map((s) => s.id);
}

/** The configuration a configuration was made from: as recorded, or (older data) the one before it in its setup. */
export function baseOf(revisions: SuspensionRevision[], revision: SuspensionRevision): SuspensionRevision | undefined {
  if (revision.basedOnId) {
    const base = revisions.find((r) => r.id === revision.basedOnId);
    if (base) return base;
  }
  return previousRevision(revisions, revision);
}

/** Configurations newest first (highest number first). */
export function byNumberDesc(revisions: SuspensionRevision[]): SuspensionRevision[] {
  return [...revisions].sort((a, b) => b.configNumber - a.configNumber);
}

/** Cookie remembering Quick Tune or the Suspension Map. */
export const VIEW_COOKIE = "sledwerx-suspension-view";
export type SuspensionViewMode = "quick" | "map";
export function parseViewMode(value: string | undefined): SuspensionViewMode {
  return value === "map" ? "map" : "quick";
}
