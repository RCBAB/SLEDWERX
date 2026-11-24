/**
 * Non-blocking warnings about configurations that rode badly before. A
 * configuration "matches" when every suspension value and the skis and
 * carbides are the same. Conditions matter: the warning names the conditions
 * it was disliked in, and mentions where the same configuration was liked.
 */
import { normalizeNumber } from "./validation";
import {
  CONDITION_LABEL,
  configName,
  sameEquipment,
  type Equipment,
  type Snapshot,
  type SuspensionRevision,
  type TrailCondition,
} from "./types";

const comparable = (value: string) => {
  const n = normalizeNumber(value);
  return n === null ? value.trim() : String(Number(n));
};

/** Same values for the same settings (blank settings ignored; "10" = "10.0"). */
export function sameValues(a: Snapshot, b: Snapshot): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key]?.value;
    const y = b[key]?.value;
    if (x == null || y == null) {
      if (x !== y) return false;
      continue;
    }
    if (comparable(x) !== comparable(y)) return false;
  }
  return true;
}

/**
 * Saved configurations with exactly these values and equipment. Compared as
 * shown: documented measurements, and outstanding turns as "+2.5 turns"
 * (Migration 12), so turns count too.
 */
export function matchingConfigurations(
  target: { values: Snapshot; equipment: Equipment },
  revisions: SuspensionRevision[],
): SuspensionRevision[] {
  return revisions.filter((r) => sameEquipment(r.equipment, target.equipment) && sameValues(r.display, target.values));
}

/** "Loose Snow", "Loose Snow and Sloppy", "Loose Snow, Sloppy and Hard Pack". */
export function listConditions(conditions: TrailCondition[]): string {
  const labels = conditions.map((c) => CONDITION_LABEL[c]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function union(lists: TrailCondition[][]): TrailCondition[] {
  const seen = new Set(lists.flat());
  return (Object.keys(CONDITION_LABEL) as TrailCondition[]).filter((c) => seen.has(c));
}

export type FeedbackWarning = {
  message: string;
  /** "Trail 2" etc.: where the earlier feedback is. */
  configurations: string[];
  disliked: TrailCondition[];
  liked: TrailCondition[];
};

/**
 * A warning if any matching configuration was rated Disliked, or null. Never
 * blocks anything; the caller shows it and lets the user go ahead.
 */
export function dislikeWarning(matches: SuspensionRevision[]): FeedbackWarning | null {
  const disliked = matches.flatMap((r) => r.feedback.filter((f) => f.rating === "disliked").map((f) => ({ r, f })));
  if (!disliked.length) return null;
  const liked = matches.flatMap((r) => r.feedback.filter((f) => f.rating === "liked"));
  const dislikedIn = union(disliked.map(({ f }) => f.conditions));
  const likedIn = union(liked.map((f) => f.conditions));
  const where = dislikedIn.length ? ` under ${listConditions(dislikedIn)} conditions` : " (no trail conditions were recorded)";
  const also = liked.length ? ` It was rated Liked${likedIn.length ? ` under ${listConditions(likedIn)}` : ""} too.` : "";
  const configurations = [...new Set(disliked.map(({ r }) => r.configNumber))].sort((a, b) => a - b).map(configName);
  return {
    message: `This suspension configuration was previously rated Disliked${where}.${also} Review your earlier feedback before trying it again.`,
    configurations,
    disliked: dislikedIn,
    liked: likedIn,
  };
}
