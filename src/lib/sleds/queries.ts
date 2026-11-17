import "server-only";

import { cache } from "react";

import type { RangeReading } from "@/lib/service/meter-range";
import { createClient } from "@/lib/supabase/server";

import { PHOTO_BUCKET, PHOTO_URL_TTL, type SledRole, type SledStatus } from "./constants";
import { sledIdSchema } from "./validation";

// Every query runs as the signed-in user, so Row Level Security decides what
// is visible. Nothing here bypasses it.

type ReadingRow = {
  id: string | null;
  sled_id: string | null;
  read_on: string | null;
  odometer_mi: number | null;
  engine_hours: number | null;
  odometer_reset: boolean | null;
  hour_meter_reset: boolean | null;
  total_mi: number | null;
  total_engine_hours: number | null;
  created_at: string | null;
  created_by: string | null;
  version: number | null;
};

export type MeterSummary = {
  odometer: { value: number; total: number | null; readOn: string } | null;
  engineHours: { value: number; total: number | null; readOn: string } | null;
};

export type SledListItem = {
  id: string;
  ownerId: string;
  make: string;
  model: string;
  modelYear: number;
  nickname: string | null;
  status: SledStatus;
  photoUrl: string | null;
  meters: MeterSummary;
};

export type Reading = {
  id: string;
  readOn: string;
  odometer: number | null;
  engineHours: number | null;
  odometerReset: boolean;
  hourMeterReset: boolean;
  totalMiles: number | null;
  totalHours: number | null;
  createdBy: string | null;
  version: number;
};

export type SledDetail = {
  id: string;
  ownerId: string;
  role: SledRole;
  make: string;
  model: string;
  modelYear: number;
  nickname: string | null;
  vin: string | null;
  status: SledStatus;
  purchaseDate: string | null;
  engineDescription: string | null;
  displacementCc: number | null;
  notes: string | null;
  photoPath: string | null;
  photoUrl: string | null;
  version: number;
  meters: MeterSummary;
  readings: Reading[];
};

const READING_COLUMNS =
  "id, sled_id, read_on, odometer_mi, engine_hours, odometer_reset, hour_meter_reset, total_mi, total_engine_hours, created_at, created_by, version";

/** Readings must arrive newest first. */
function summarizeMeters(readings: ReadingRow[]): MeterSummary {
  const odo = readings.find((r) => r.odometer_mi != null);
  const hrs = readings.find((r) => r.engine_hours != null);
  return {
    odometer: odo ? { value: odo.odometer_mi!, total: odo.total_mi, readOn: odo.read_on! } : null,
    engineHours: hrs ? { value: hrs.engine_hours!, total: hrs.total_engine_hours, readOn: hrs.read_on! } : null,
  };
}

async function signedPhotoUrls(paths: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;
  const supabase = await createClient();
  const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, PHOTO_URL_TTL);
  for (const item of data ?? []) {
    if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
  }
  return urls;
}

/** Sleds the user owns or that are shared with them, oldest first. */
export async function listSleds(): Promise<SledListItem[]> {
  return (await loadSleds()).map((sled) => {
    const { readings, ...item } = sled;
    void readings;
    return item;
  });
}

export type GarageSled = SledListItem & {
  /** Up to the newest 200 readings, oldest first (as on the sled page), for checking service mileage. */
  readings: RangeReading[];
};

/** listSleds() plus each sled's readings, for the Garage Board. */
export async function listGarageSleds(): Promise<GarageSled[]> {
  return loadSleds();
}

async function loadSleds(): Promise<GarageSled[]> {
  const supabase = await createClient();
  const { data: sleds, error } = await supabase
    .from("sleds")
    .select("id, owner_id, model_year, make, model, nickname, status, photo_path")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Could not load your snowmobiles.");
  if (!sleds.length) return [];

  const [{ data: readings, error: readingsError }, photos] = await Promise.all([
    supabase
      .from("sled_reading_history")
      .select(READING_COLUMNS)
      .in(
        "sled_id",
        sleds.map((s) => s.id),
      )
      .order("read_on", { ascending: false })
      .order("created_at", { ascending: false }),
    signedPhotoUrls(sleds.flatMap((s) => (s.photo_path ? [s.photo_path] : []))),
  ]);
  if (readingsError) throw new Error("Could not load your snowmobiles.");

  const bySled = new Map<string, ReadingRow[]>();
  for (const reading of readings ?? []) {
    const list = bySled.get(reading.sled_id!) ?? [];
    list.push(reading);
    bySled.set(reading.sled_id!, list);
  }

  return sleds.map((s) => {
    const rows = bySled.get(s.id) ?? [];
    return {
      id: s.id,
      ownerId: s.owner_id,
      make: s.make,
      model: s.model,
      modelYear: s.model_year,
      nickname: s.nickname,
      status: s.status,
      photoUrl: s.photo_path ? (photos.get(s.photo_path) ?? null) : null,
      meters: summarizeMeters(rows),
      readings: rows
        .slice(0, 200)
        .reverse()
        .map((r) => ({
          id: r.id!,
          readOn: r.read_on!,
          odometer: r.odometer_mi,
          engineHours: r.engine_hours,
          odometerReset: Boolean(r.odometer_reset),
          hourMeterReset: Boolean(r.hour_meter_reset),
        })),
    };
  });
}

/**
 * One sled with the user's role on it, or null if it doesn't exist, is in
 * Recently Deleted, or isn't visible to this user (callers show a 404 for
 * all three, so the app never reveals whether a sled exists).
 */
export const getSled = cache(async (sledId: string, userId: string): Promise<SledDetail | null> => {
  if (!sledIdSchema.safeParse(sledId).success) return null;
  const supabase = await createClient();

  const { data: sled, error } = await supabase
    .from("sleds")
    .select(
      "id, owner_id, model_year, make, model, nickname, vin, status, purchase_date, engine_description, engine_displacement_cc, notes, photo_path, version",
    )
    .eq("id", sledId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Could not load this snowmobile.");
  if (!sled) return null;

  const [role, { data: readings, error: readingsError }, photos] = await Promise.all([
    sledRole(sled.id, sled.owner_id, userId),
    supabase
      .from("sled_reading_history")
      .select(READING_COLUMNS)
      .eq("sled_id", sled.id)
      .order("read_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    signedPhotoUrls(sled.photo_path ? [sled.photo_path] : []),
  ]);
  if (readingsError) throw new Error("Could not load this snowmobile.");
  const rows = readings ?? [];

  return {
    id: sled.id,
    ownerId: sled.owner_id,
    role,
    make: sled.make,
    model: sled.model,
    modelYear: sled.model_year,
    nickname: sled.nickname,
    vin: sled.vin,
    status: sled.status,
    purchaseDate: sled.purchase_date,
    engineDescription: sled.engine_description,
    displacementCc: sled.engine_displacement_cc,
    notes: sled.notes,
    photoPath: sled.photo_path,
    photoUrl: sled.photo_path ? (photos.get(sled.photo_path) ?? null) : null,
    version: sled.version,
    meters: summarizeMeters(rows),
    readings: rows.map((r) => ({
      id: r.id!,
      readOn: r.read_on!,
      odometer: r.odometer_mi,
      engineHours: r.engine_hours,
      odometerReset: Boolean(r.odometer_reset),
      hourMeterReset: Boolean(r.hour_meter_reset),
      totalMiles: r.total_mi,
      totalHours: r.total_engine_hours,
      createdBy: r.created_by,
      version: r.version ?? 1,
    })),
  };
});

async function sledRole(sledId: string, ownerId: string, userId: string): Promise<SledRole> {
  if (ownerId === userId) return "owner";
  const supabase = await createClient();
  const { data } = await supabase
    .from("sled_shares")
    .select("role")
    .eq("sled_id", sledId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .is("suspended_at", null)
    .maybeSingle();
  // The sled is only visible through an active share, so a missing row means
  // the share changed mid-request: show it read-only.
  return data?.role ?? "viewer";
}

/** The newest reading of a sled (used to check "Fix last reading" targets it). */
export async function latestReading(sledId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sled_reading_history")
    .select("id, version, created_by")
    .eq("sled_id", sledId)
    .order("read_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}
