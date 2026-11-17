"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { PHOTO_BUCKET } from "@/lib/sleds/constants";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { canFixReading } from "@/lib/sleds/permissions";
import { getSled, latestReading } from "@/lib/sleds/queries";
import {
  addReadingSchema,
  createSledSchema,
  fixReadingSchema,
  futureDateError,
  isValidPhotoPath,
  sledIdSchema,
  updateSledSchema,
} from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, formValues } from "@/lib/validation/auth";

// Every write runs as the signed-in user through Row Level Security and the
// database triggers (ownership, versioning, audit, reading checks). The checks
// here only give friendlier messages; they are not the security boundary.

export type SledActionState = {
  error?: string;
  message?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string | undefined>;
  sledId?: string;
  ok?: boolean;
  /** Set on success, so forms can reset themselves. */
  savedAt?: number;
};

async function signedInUser(next: string) {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

function sledIdFrom(formData: FormData): string | null {
  const parsed = sledIdSchema.safeParse(formData.get("sledId"));
  return parsed.success ? parsed.data : null;
}

/** Puts database messages about readings next to the field they concern. */
function readingFieldErrors(message: string): SledActionState["fieldErrors"] {
  if (message.startsWith("Odometer")) return { odometer: [message] };
  if (message.startsWith("Engine-hour")) return { engineHours: [message] };
  if (message.startsWith("The reading date")) return { readOn: [message] };
  return undefined;
}

/** Refuses dates after the user's own today (time zone sent by their browser). */
function futureDateErrors(formData: FormData, field: string, value: string | undefined) {
  const error = futureDateError(value, formData.get("timeZone"));
  return error ? { [field]: [error] } : undefined;
}

async function removePhotoObject(path: string | null | undefined) {
  if (!path) return;
  const supabase = await createClient();
  // Best effort: a leftover file is harmless and only visible to sled users.
  await supabase.storage.from(PHOTO_BUCKET).remove([path]);
}

// ---------------------------------------------------------------------------
// Add Snowmobile
// ---------------------------------------------------------------------------
const CREATE_FIELDS = ["make", "model", "modelYear", "nickname", "vin", "odometer", "engineHours", "readOn"] as const;

export async function createSled(_prev: SledActionState, formData: FormData): Promise<SledActionState> {
  await signedInUser("/garage/new");
  const raw = formValues(formData, CREATE_FIELDS);
  const parsed = createSledSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };

  const sled = parsed.data;
  const dateErrors = futureDateErrors(formData, "readOn", sled.readOn);
  if (dateErrors) return { fieldErrors: dateErrors, error: dateErrors.readOn[0], values: raw };

  const supabase = await createClient();
  const { data: sledId, error } = await supabase.rpc("create_sled", {
    p_make: sled.make,
    p_model: sled.model,
    p_model_year: sled.modelYear,
    p_odometer_mi: sled.odometer!,
    p_engine_hours: sled.engineHours,
    p_nickname: sled.nickname,
    p_vin: sled.vin,
    p_read_on: sled.readOn,
  });
  if (error || !sledId) {
    const message = sledErrorMessage(error);
    return { error: message, fieldErrors: readingFieldErrors(message), values: raw };
  }
  return { ok: true, sledId };
}

/** Attaches an uploaded photo to a new sled (first version). */
export async function attachNewSledPhoto(sledId: string, photoPath: string): Promise<SledActionState> {
  await signedInUser("/garage");
  if (!sledIdSchema.safeParse(sledId).success || !isValidPhotoPath(sledId, photoPath)) {
    return { error: "That photo can't be used." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sleds")
    .update({ photo_path: photoPath, version: 1 })
    .eq("id", sledId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }) };
  return { ok: true, sledId };
}

// ---------------------------------------------------------------------------
// Edit details
// ---------------------------------------------------------------------------
const UPDATE_FIELDS = [
  "make",
  "model",
  "modelYear",
  "nickname",
  "vin",
  "status",
  "purchaseDate",
  "engineDescription",
  "displacementCc",
  "notes",
  "version",
  "photoPath",
  "removePhoto",
] as const;

export async function updateSled(_prev: SledActionState, formData: FormData): Promise<SledActionState> {
  const sledId = sledIdFrom(formData);
  const user = await signedInUser(sledId ? `/garage/${sledId}/edit` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, UPDATE_FIELDS);
  const parsed = updateSledSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateErrors = futureDateErrors(formData, "purchaseDate", input.purchaseDate);
  if (dateErrors) return { fieldErrors: dateErrors, values: raw };

  const current = await getSled(sledId, user.id);
  if (!current) return { error: "Snowmobile not found." };

  let photoPath: string | null | undefined; // undefined = unchanged
  if (input.photoPath) {
    if (!isValidPhotoPath(sledId, input.photoPath)) return { error: "That photo can't be used.", values: raw };
    photoPath = input.photoPath;
  } else if (input.removePhoto) {
    photoPath = null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sleds")
    .update({
      make: input.make,
      model: input.model,
      model_year: input.modelYear,
      nickname: input.nickname ?? null,
      vin: input.vin ?? null,
      status: input.status as (typeof current)["status"],
      purchase_date: input.purchaseDate ?? null,
      engine_description: input.engineDescription ?? null,
      engine_displacement_cc: input.displacementCc ?? null,
      notes: input.notes ?? null,
      ...(photoPath !== undefined ? { photo_path: photoPath } : {}),
      version: input.version,
    })
    .eq("id", sledId)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return { error: sledErrorMessage(error ?? { code: "42501" }), values: raw };
  }

  if (photoPath !== undefined && current.photoPath && current.photoPath !== photoPath) {
    await removePhotoObject(current.photoPath);
  }
  return { ok: true, sledId };
}

// ---------------------------------------------------------------------------
// Update mileage
// ---------------------------------------------------------------------------
const READING_FIELDS = ["odometer", "engineHours", "readOn", "odometerReset", "hourMeterReset"] as const;

export async function addReading(_prev: SledActionState, formData: FormData): Promise<SledActionState> {
  const sledId = sledIdFrom(formData);
  await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, READING_FIELDS);
  const parsed = addReadingSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const reading = parsed.data;
  const dateErrors = futureDateErrors(formData, "readOn", reading.readOn);
  if (dateErrors) return { fieldErrors: dateErrors, values: raw };

  const supabase = await createClient();
  const { error } = await supabase.from("sled_readings").insert({
    sled_id: sledId,
    read_on: reading.readOn,
    odometer_mi: reading.odometer ?? null,
    engine_hours: reading.engineHours ?? null,
    odometer_reset: reading.odometerReset,
    hour_meter_reset: reading.hourMeterReset,
  });
  if (error) {
    const message = sledErrorMessage(error);
    return { error: message, fieldErrors: readingFieldErrors(message), values: raw };
  }

  refresh();
  return { ok: true, message: "Mileage updated.", savedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Fix last reading (correct or remove the newest reading)
// ---------------------------------------------------------------------------
export async function fixLastReading(_prev: SledActionState, formData: FormData): Promise<SledActionState> {
  const sledId = sledIdFrom(formData);
  const user = await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, [...READING_FIELDS, "readingId", "version", "intent"] as const);
  const remove = raw.intent === "remove";

  const latest = await latestReading(sledId);
  if (!latest || latest.id !== raw.readingId) {
    return { error: "A newer reading was added. Reload the page and try again.", values: raw };
  }

  const supabase = await createClient();
  let query;
  if (remove) {
    const version = Number(raw.version);
    if (!Number.isInteger(version)) return { error: "Reading not found." };
    // The database sets deleted_at/deleted_by itself and keeps the reading in
    // the audit history (soft delete; owners and editors only).
    query = supabase
      .from("sled_readings")
      .update({ deleted_at: new Date().toISOString(), version })
      .eq("id", latest.id)
      .eq("sled_id", sledId);
  } else {
    const parsed = fixReadingSchema.safeParse(raw);
    if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
    const sled = await getSled(sledId, user.id);
    if (!sled || !canFixReading(sled.role, latest.created_by, user.id)) {
      return { error: "You don't have permission to do that." };
    }
    const reading = parsed.data;
    const dateErrors = futureDateErrors(formData, "readOn", reading.readOn);
    if (dateErrors) return { fieldErrors: dateErrors, values: raw };
    query = supabase
      .from("sled_readings")
      .update({
        read_on: reading.readOn,
        odometer_mi: reading.odometer ?? null,
        engine_hours: reading.engineHours ?? null,
        odometer_reset: reading.odometerReset,
        hour_meter_reset: reading.hourMeterReset,
        version: reading.version,
      })
      .eq("id", latest.id)
      .eq("sled_id", sledId);
  }

  const { data, error } = await query.select("id").maybeSingle();
  if (error || !data) {
    const message = sledErrorMessage(error ?? { code: "42501" });
    return { error: message, fieldErrors: readingFieldErrors(message), values: raw };
  }

  refresh();
  return { ok: true, message: remove ? "Last reading removed." : "Last reading corrected.", savedAt: Date.now() };
}
