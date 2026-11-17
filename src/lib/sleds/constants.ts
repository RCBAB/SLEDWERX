import type { Database } from "@/lib/supabase/database.types";

export type SledStatus = Database["public"]["Enums"]["sled_status"];
export type SledRole = "owner" | "editor" | "mechanic" | "viewer";

export const SLED_STATUSES: readonly SledStatus[] = ["ready", "needs_attention", "out_of_service", "stored"];

export const STATUS_LABELS: Record<SledStatus, string> = {
  ready: "Ready",
  needs_attention: "Needs attention",
  out_of_service: "Out of service",
  stored: "Stored",
};

/** Suggestions only: any manufacturer can be typed. */
export const MAKE_SUGGESTIONS = ["Ski-Doo", "Lynx", "Polaris", "Arctic Cat", "Yamaha"] as const;

export const PHOTO_BUCKET = "sled-photos";
/** Signed photo URLs stay valid this long (seconds). */
export const PHOTO_URL_TTL = 60 * 60;
/** Longest side of an uploaded photo after resizing in the browser. */
export const PHOTO_MAX_DIMENSION = 1600;
/** Largest original file accepted before resizing. */
export const PHOTO_MAX_INPUT_BYTES = 25 * 1024 * 1024;
