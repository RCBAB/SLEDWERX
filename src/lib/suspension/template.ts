import type { SettingValueType, SuspensionZone } from "./types";

/**
 * The one suggested starting list of settings (names, places and units only:
 * never values, which come from the rider). Everything can be renamed,
 * removed, re-unitted or added to afterwards.
 */
export type TemplateSetting = { name: string; zone: SuspensionZone; valueType: SettingValueType; unit: string | null };

export const SUGGESTED_SETTINGS: readonly TemplateSetting[] = [
  { name: "Compression", zone: "front_left_shock", valueType: "number", unit: "clicks" },
  { name: "Rebound", zone: "front_left_shock", valueType: "number", unit: "clicks" },
  { name: "Preload", zone: "front_left_shock", valueType: "number", unit: "in" },
  { name: "Compression", zone: "front_right_shock", valueType: "number", unit: "clicks" },
  { name: "Rebound", zone: "front_right_shock", valueType: "number", unit: "clicks" },
  { name: "Preload", zone: "front_right_shock", valueType: "number", unit: "in" },
  { name: "Compression", zone: "rear_front_shock", valueType: "number", unit: "clicks" },
  { name: "Rebound", zone: "rear_front_shock", valueType: "number", unit: "clicks" },
  { name: "Compression", zone: "rear_rear_shock", valueType: "number", unit: "clicks" },
  { name: "Rebound", zone: "rear_rear_shock", valueType: "number", unit: "clicks" },
  { name: "Preload", zone: "rear_rear_shock", valueType: "number", unit: "in" },
  { name: "Limiter strap", zone: "rear_springs_limiter", valueType: "number", unit: "hole" },
  { name: "Torsion spring position", zone: "rear_springs_limiter", valueType: "number", unit: "position" },
  { name: "Track tension", zone: "rear_general", valueType: "number", unit: "in" },
];
