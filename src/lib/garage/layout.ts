/**
 * The Garage Board layout preference, kept in user_preferences.garage_mode
 * (a private JSON object from Migration 1). Other Garage Mode settings may be
 * stored beside it, so it is always merged, never replaced.
 */
export const GARAGE_LAYOUTS = ["cards", "compact"] as const;
export type GarageLayout = (typeof GARAGE_LAYOUTS)[number];

/** Full Cards for new users, and whenever the stored value isn't understood. */
export const DEFAULT_LAYOUT: GarageLayout = "cards";

export function isGarageLayout(value: unknown): value is GarageLayout {
  return typeof value === "string" && (GARAGE_LAYOUTS as readonly string[]).includes(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function layoutFromGarageMode(garageMode: unknown): GarageLayout {
  const layout = asObject(garageMode).layout;
  return isGarageLayout(layout) ? layout : DEFAULT_LAYOUT;
}

/** The stored object with the new layout, keeping any other settings. */
export function withLayout(garageMode: unknown, layout: GarageLayout): Record<string, unknown> {
  return { ...asObject(garageMode), layout };
}
