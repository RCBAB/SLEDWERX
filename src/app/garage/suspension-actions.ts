"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { suspensionCapabilities } from "@/lib/sleds/permissions";
import { suspensionPhotoUploadsEnabled } from "@/lib/suspension/photo-flag";
import { getSled } from "@/lib/sleds/queries";
import { changedValues } from "@/lib/suspension/diff";
import { suspensionErrorMessage, type SuspensionSubject } from "@/lib/suspension/errors";
import { isSchemaMissing, parseSnapshot } from "@/lib/suspension/queries";
import { SUGGESTED_SETTINGS } from "@/lib/suspension/template";
import {
  MAX_MEASUREMENT_PHOTOS,
  MAX_SUSPENSION_PHOTOS,
  isCarbideLength,
  isSkiModel,
  isZone,
  settingsInZone,
  type SettingValueType,
} from "@/lib/suspension/types";
import { adjustmentSchema, checkSettingValue, feedbackSchema, settingSchema, uuidSchema } from "@/lib/suspension/validation";
import { futureDateError } from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, formValues } from "@/lib/validation/auth";

// Suspension changes run as the signed-in user through Row Level Security,
// the Migration 7 triggers and its functions: who may manage setups and
// settings, record adjustments, add feedback and photos is decided there.
// The checks here only give friendlier messages, next to the right field.

export type SuspensionActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string | undefined>;
  ok?: boolean;
  /** The saved setup, setting, revision or feedback. */
  id?: string;
  /** Saved, but with something to tell (e.g. a photo couldn't be added). */
  warning?: string;
  /** The saved or activated configuration's number ("Trail N"). */
  configNumber?: number;
  savedAt?: number;
};

const SCHEMA_MISSING = "Suspension Quick Tune needs a database update that hasn't been applied yet.";

type DbError = { code?: string; message?: string } | null | undefined;

const PHOTO_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|webp)$/;
/** Prefix of the form fields that carry setting values ("value.<setting id>"). */
const VALUE_FIELD = "value.";

async function signedInUser() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=%2Fgarage");
  return user;
}

function idFrom(formData: FormData, key: string) {
  const parsed = uuidSchema.safeParse(formData.get(key));
  return parsed.success ? parsed.data : null;
}

function versionFrom(formData: FormData) {
  return validVersion(Number(formData.get("version")));
}

function validVersion(version: number) {
  return Number.isInteger(version) && version > 0 ? version : null;
}

function done(id?: string): SuspensionActionState {
  refresh();
  return { ok: true, id, savedAt: Date.now() };
}

function failed(error: DbError, subject: SuspensionSubject, extra?: Partial<SuspensionActionState>): SuspensionActionState {
  return { error: suspensionErrorMessage(error ?? { code: "42501" }, subject), ...extra };
}

/** A soft delete or restore of one row, with the version check. */
async function setDeleted(
  table: "suspension_setups" | "suspension_settings" | "suspension_feedback" | "suspension_photos" | "sled_measurement_photos",
  id: string,
  version: number,
  deleted: boolean,
  subject: SuspensionSubject,
): Promise<SuspensionActionState> {
  await signedInUser();
  if (!uuidSchema.safeParse(id).success || !validVersion(version)) return { error: "Reload the page and try again." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: deleted ? new Date().toISOString() : null, version })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error || !data) return failed(error, subject);
  return done(id);
}

// ---------------------------------------------------------------------------
// Setups (Migration 7). Quick Tune keeps one numbered sequence per sled, so
// setups are no longer created or managed in the app; one deleted earlier can
// still be brought back from Recently Deleted.
// ---------------------------------------------------------------------------

/** Bring a setup and its whole history back from Recently Deleted (within 30 days). Owners and editors. */
export async function restoreSetup(setupId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_setups", setupId, version, false, "setup");
}

// ---------------------------------------------------------------------------
// Settings (the sled's one list, shared by all its setups)
// ---------------------------------------------------------------------------

/** Add a setting to the sled's list, or edit one. Owners and editors. */
export async function saveSetting(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const raw = formValues(formData, ["name", "zone", "valueType", "unit", "notes"] as const);
  const parsed = settingSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const fields = { name: input.name, zone: input.zone, value_type: input.valueType, unit: input.unit ?? null, notes: input.notes ?? null };
  const supabase = await createClient();
  const nameError = (error: DbError) =>
    error?.code === "23505" ? { fieldErrors: { name: [suspensionErrorMessage(error, "setting")] }, values: raw } : { values: raw };

  const settingId = idFrom(formData, "settingId");
  if (settingId) {
    const version = versionFrom(formData);
    if (!version) return { error: "Reload the page and try again.", values: raw };
    const { data: current } = await supabase.from("suspension_settings").select("zone, sled_id").eq("id", settingId).maybeSingle();
    if (!current) return { error: "Setting not found. Reload the page and try again.", values: raw };
    // Moving to another zone puts it at the end of that zone.
    const position = current.zone === input.zone ? undefined : await nextPosition(supabase, current.sled_id, input.zone);
    const { data, error } = await supabase
      .from("suspension_settings")
      .update({ ...fields, ...(position === undefined ? {} : { position }), version })
      .eq("id", settingId)
      .select("id")
      .maybeSingle();
    if (error || !data) return failed(error, "setting", nameError(error));
    return done(settingId);
  }

  const sledId = idFrom(formData, "sledId");
  if (!sledId) return { error: "Snowmobile not found." };
  const { data, error } = await supabase
    .from("suspension_settings")
    .insert({ sled_id: sledId, ...fields, position: await nextPosition(supabase, sledId, input.zone) })
    .select("id")
    .single();
  if (error || !data) return failed(error, "setting", nameError(error));
  return done(data.id);
}

async function nextPosition(supabase: Awaited<ReturnType<typeof createClient>>, sledId: string, zone: string): Promise<number> {
  const { data } = await supabase
    .from("suspension_settings")
    .select("position")
    .eq("sled_id", sledId)
    .eq("zone", zone)
    .is("deleted_at", null)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Math.min(999, (data?.position ?? -10) + 10);
}

/** Move a setting up or down within its zone. Owners and editors. */
export async function moveSetting(settingId: string, direction: "up" | "down"): Promise<SuspensionActionState> {
  await signedInUser();
  if (!uuidSchema.safeParse(settingId).success || (direction !== "up" && direction !== "down")) return { error: "Setting not found." };
  const supabase = await createClient();
  const { data: setting } = await supabase.from("suspension_settings").select("sled_id, zone").eq("id", settingId).maybeSingle();
  if (!setting || !isZone(setting.zone)) return { error: "Setting not found. Reload the page and try again." };
  const { data: rows, error: loadError } = await supabase
    .from("suspension_settings")
    .select("id, name, zone, position, version")
    .eq("sled_id", setting.sled_id)
    .eq("zone", setting.zone)
    .is("deleted_at", null);
  if (loadError || !rows) return failed(loadError, "setting");

  const zone = setting.zone;
  const ordered = settingsInZone(
    rows.map((r) => ({ ...r, zone })),
    zone,
  );
  const from = ordered.findIndex((r) => r.id === settingId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ordered.length) return done(settingId);
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];

  for (const [n, row] of ordered.entries()) {
    const position = Math.min(999, n * 10);
    if (row.position === position) continue;
    const { data, error } = await supabase
      .from("suspension_settings")
      .update({ position, version: row.version })
      .eq("id", row.id)
      .select("id")
      .maybeSingle();
    if (error || !data) return failed(error, "setting");
  }
  return done(settingId);
}

/**
 * Start a sled with the one suggested settings list (names, places and units;
 * no values). Only while the list is empty. Owners and editors.
 */
export async function applySuggestedSettings(sledId: string): Promise<SuspensionActionState> {
  await signedInUser();
  if (!uuidSchema.safeParse(sledId).success) return { error: "Snowmobile not found." };
  const supabase = await createClient();
  const { count, error: countError } = await supabase
    .from("suspension_settings")
    .select("id", { count: "exact", head: true })
    .eq("sled_id", sledId)
    .is("deleted_at", null);
  if (countError) return failed(countError, "setting");
  if (count) return { error: "This snowmobile already has settings. Add or change them in the settings list." };
  const positions = new Map<string, number>();
  const rows = SUGGESTED_SETTINGS.map((t) => {
    const position = positions.get(t.zone) ?? 0;
    positions.set(t.zone, position + 10);
    return { sled_id: sledId, name: t.name, zone: t.zone, value_type: t.valueType, unit: t.unit, position };
  });
  // One statement: all or nothing.
  const { error } = await supabase.from("suspension_settings").insert(rows);
  if (error) return failed(error, "setting");
  return done();
}

/** Move a setting (and its reference photos) to Recently Deleted. History keeps its values. Owners and editors. */
export async function deleteSetting(settingId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_settings", settingId, version, true, "setting");
}

/** Bring a setting and its reference photos back (within 30 days). Owners and editors. */
export async function restoreSetting(settingId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_settings", settingId, version, false, "setting");
}

// ---------------------------------------------------------------------------
// Configurations (Migration 9): each save is the next "Trail N" and becomes
// the active one. Owners, editors and mechanics.
// ---------------------------------------------------------------------------

export type ConfigurationInput = {
  sledId: string;
  /** The active configuration the changes were made on (null before the first save). */
  baseRevisionId: string | null;
  /** Setting id -> new value ("" or null clears it). Only changed settings. */
  changes: Record<string, string | null>;
  ski?: string | null;
  carbide?: string | null;
  note?: string | null;
  odometer?: string | number | null;
  engineHours?: string | number | null;
  idempotencyKey: string;
};

/**
 * Save the next numbered configuration. Values are checked here for friendly
 * messages (per setting), then by the database, which also carries every
 * unchanged value forward, refuses a save with nothing changed, and refuses a
 * save from a configuration that is no longer active.
 */
async function saveConfigurationCore(input: ConfigurationInput): Promise<SuspensionActionState> {
  await signedInUser();
  const sledId = uuidSchema.safeParse(input.sledId);
  const base = input.baseRevisionId == null ? { success: true as const, data: null } : uuidSchema.safeParse(input.baseRevisionId);
  if (!sledId.success || !base.success) return { error: "Reload the page and try again." };
  const meta = adjustmentSchema.safeParse({
    note: input.note ?? "",
    odometer: input.odometer == null ? "" : String(input.odometer),
    engineHours: input.engineHours == null ? "" : String(input.engineHours),
    idempotencyKey: input.idempotencyKey,
  });
  if (!meta.success) return { fieldErrors: fieldErrorsOf(meta.error) };
  if (input.ski != null && !isSkiModel(input.ski)) return { error: "Choose a ski model." };
  if (input.carbide != null && !isCarbideLength(input.carbide)) return { error: "Choose a carbide length." };

  const supabase = await createClient();
  const ids = Object.keys(input.changes ?? {});
  const changes: Record<string, string | null> = {};
  const fieldErrors: Record<string, string[]> = {};
  if (ids.length) {
    if (ids.length > 200 || !ids.every((id) => uuidSchema.safeParse(id).success)) return { error: "Reload the page and try again." };
    const { data: rows, error } = await supabase
      .from("suspension_settings")
      .select("id, name, value_type")
      .eq("sled_id", sledId.data)
      .in("id", ids)
      .is("deleted_at", null);
    if (error) return failed(error, "revision");
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    for (const id of ids) {
      const setting = byId.get(id);
      if (!setting) continue; // removed meanwhile: nothing to change
      const check = checkSettingValue(setting.value_type as SettingValueType, input.changes[id] ?? "", setting.name);
      if (check.ok) changes[id] = check.value;
      else fieldErrors[`${VALUE_FIELD}${id}`] = [check.error];
    }
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors, error: Object.values(fieldErrors)[0][0] };

  const { data, error } = await supabase.rpc("save_suspension_configuration", {
    p_sled_id: sledId.data,
    ...(base.data ? { p_base_revision_id: base.data } : {}),
    p_changes: changes,
    ...(input.ski ? { p_ski_model: input.ski } : {}),
    ...(input.carbide ? { p_carbide_length: input.carbide } : {}),
    ...(meta.data.note ? { p_note: meta.data.note } : {}),
    ...(meta.data.odometer != null ? { p_odometer_mi: meta.data.odometer } : {}),
    ...(meta.data.engineHours != null ? { p_engine_hours: meta.data.engineHours } : {}),
    p_idempotency_key: meta.data.idempotencyKey,
  });
  const saved = data as { revision_id?: string; config_number?: number } | null;
  if (error || !saved?.revision_id) {
    if (isSchemaMissing(error)) return { error: SCHEMA_MISSING };
    return { error: suspensionErrorMessage(error, "configuration") };
  }
  refresh();
  return { ok: true, id: saved.revision_id, configNumber: saved.config_number, savedAt: Date.now() };
}

/** Quick Tune: save several changed values at once as the next configuration. */
export async function saveConfiguration(input: ConfigurationInput): Promise<SuspensionActionState> {
  return saveConfigurationCore({ ...input, ski: null, carbide: null });
}

/**
 * Change the installed skis and/or carbides (after the user confirmed): the
 * next configuration keeps every suspension value and records the new
 * equipment; it becomes active. Earlier configurations keep theirs.
 */
export async function changeEquipment(input: {
  sledId: string;
  baseRevisionId: string | null;
  ski: string;
  carbide: string;
  idempotencyKey: string;
}): Promise<SuspensionActionState> {
  if (!isSkiModel(input.ski)) return { error: "Choose a ski model." };
  if (!isCarbideLength(input.carbide)) return { error: "Choose a carbide length." };
  return saveConfigurationCore({ ...input, changes: {} });
}

/**
 * The Record adjustment form (Suspension Map, snowmobile page, Garage Board):
 * values typed per setting; only those that differ from the active
 * configuration are sent.
 */
export async function saveAdjustment(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const sledId = idFrom(formData, "sledId");
  if (!sledId) return { error: "Snowmobile not found. Reload the page and try again." };
  const baseRevisionId = idFrom(formData, "baseRevisionId");
  const meta = formValues(formData, ["note", "odometer", "engineHours", "idempotencyKey"] as const);
  const typed: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith(VALUE_FIELD) && typeof value === "string") typed[key.slice(VALUE_FIELD.length)] = value;
  }
  const values = { ...meta, ...Object.fromEntries(Object.entries(typed).map(([id, v]) => [`${VALUE_FIELD}${id}`, v])) };
  const parsed = adjustmentSchema.safeParse(meta);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const supabase = await createClient();
  let current: ReturnType<typeof parseSnapshot> = {};
  if (baseRevisionId) {
    const { data: base } = await supabase
      .from("suspension_revisions")
      .select("setting_values")
      .eq("id", baseRevisionId)
      .eq("sled_id", sledId)
      .maybeSingle();
    if (!base) return { error: "The active configuration was changed by someone else. Reload it and try again.", values };
    current = parseSnapshot(base.setting_values);
  }
  const { data: settingRows, error: settingsError } = await supabase
    .from("suspension_settings")
    .select("id, name, value_type")
    .eq("sled_id", sledId)
    .is("deleted_at", null);
  if (settingsError) return failed(settingsError, "revision", { values });
  const settings = new Map((settingRows ?? []).map((s) => [s.id, s]));

  const edited: Record<string, string | null> = {};
  const fieldErrors: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(typed)) {
    const setting = settings.get(id);
    if (!setting) continue;
    const check = checkSettingValue(setting.value_type as SettingValueType, value, setting.name);
    if (check.ok) edited[id] = check.value;
    else fieldErrors[`${VALUE_FIELD}${id}`] = [check.error];
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors, values };

  const changes = changedValues(current, edited);
  if (!Object.keys(changes).length) return { error: "Nothing changed. Change at least one value to save an adjustment.", values };
  const result = await saveConfigurationCore({
    sledId,
    baseRevisionId,
    changes,
    note: parsed.data.note ?? null,
    odometer: parsed.data.odometer ?? null,
    engineHours: parsed.data.engineHours ?? null,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return result.ok ? result : { ...result, values };
}

/**
 * Make an earlier configuration active. Never creates one. If it was saved with
 * other skis or carbides, `equipmentInstalled` must confirm the user has
 * fitted them (the installed equipment then follows). Owners, editors and mechanics.
 */
export async function activateConfiguration(revisionId: string, equipmentInstalled: boolean): Promise<SuspensionActionState> {
  await signedInUser();
  if (!uuidSchema.safeParse(revisionId).success) return { error: "Configuration not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("activate_suspension_configuration", {
    p_revision_id: revisionId,
    p_equipment_installed: equipmentInstalled === true,
  });
  if (error) {
    if (isSchemaMissing(error)) return { error: SCHEMA_MISSING };
    return { error: suspensionErrorMessage(error, "configuration") };
  }
  const result = data as { config_number?: number } | null;
  refresh();
  return { ok: true, id: revisionId, configNumber: result?.config_number, savedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Ride evaluations (several per configuration; never a new configuration)
// ---------------------------------------------------------------------------

/** Add a ride evaluation to a configuration, or edit one (owners and editors any, mechanics their own). */
export async function saveFeedback(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const raw = formValues(formData, ["rating", "riddenOn", "note", "highTemp"] as const);
  const conditions = formData.getAll("conditions").filter((c): c is string => typeof c === "string");
  const values = { ...raw, conditions: conditions.join(",") };
  const parsed = feedbackSchema.safeParse({ ...raw, conditions });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };
  const dateError = futureDateError(parsed.data.riddenOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { riddenOn: [dateError] }, values };
  const fields = {
    rating: parsed.data.rating,
    ridden_on: parsed.data.riddenOn,
    conditions: parsed.data.conditions,
    high_temp_f: parsed.data.highTemp ?? null,
    note: parsed.data.note ?? null,
  };
  const supabase = await createClient();

  const feedbackId = idFrom(formData, "feedbackId");
  if (feedbackId) {
    const version = versionFrom(formData);
    if (!version) return { error: "Reload the page and try again.", values };
    const { data, error } = await supabase
      .from("suspension_feedback")
      .update({ ...fields, version })
      .eq("id", feedbackId)
      .select("id")
      .maybeSingle();
    if (error || !data) return isSchemaMissing(error) ? { error: SCHEMA_MISSING, values } : failed(error, "feedback", { values });
    return done(feedbackId);
  }

  const revisionId = idFrom(formData, "revisionId");
  const sledId = idFrom(formData, "sledId");
  if (!revisionId || !sledId) return { error: "Configuration not found. Reload the page and try again." };
  const { data, error } = await supabase
    .from("suspension_feedback")
    .insert({ revision_id: revisionId, sled_id: sledId, ...fields })
    .select("id")
    .single();
  if (error || !data) return isSchemaMissing(error) ? { error: SCHEMA_MISSING, values } : failed(error, "feedback", { values });
  return done(data.id);
}

/**
 * Bring removed feedback back (within 30 days), unchanged: author, ride date,
 * rating, note and revision stay as they were. Owners and editors. The page
 * only offers feedback whose revision is still in the history; feedback that
 * went to Recently Deleted with its setup comes back with the setup.
 */
export async function restoreFeedback(feedbackId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_feedback", feedbackId, version, false, "feedback");
}

/** Remove feedback (Recently Deleted). Owners and editors. */
export async function deleteFeedback(feedbackId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_feedback", feedbackId, version, true, "feedback");
}

// ---------------------------------------------------------------------------
// Photos (the file is uploaded from the browser with the user's own session;
// this records it). Reference photos: owners and editors. Adjustment photos:
// owners, editors and mechanics. Both refuse while the photo-upload feature
// flag is off (lib/suspension/photo-flag.ts); removing photos still works.
// ---------------------------------------------------------------------------
const PHOTO_UPLOADS_OFF = "Adding photos is turned off for now.";

export type PhotoRoom = { error?: string; room: number; canRemoveFiles: boolean };

/**
 * Checked BEFORE any file is uploaded, so an upload that the database would
 * refuse afterwards (parent removed, no permission, already 6 photos) never
 * leaves a file behind. Returns how many more photos fit, and whether this
 * user may remove files (owners and editors; storage policy), which decides
 * whether a file can be cleaned up if saving its record still fails.
 */
export async function prepareSuspensionPhotos(sledId: string, parent: { kind: "setting" | "revision"; id: string }): Promise<PhotoRoom> {
  const user = await signedInUser();
  const none = (error: string): PhotoRoom => ({ error, room: 0, canRemoveFiles: false });
  if (!suspensionPhotoUploadsEnabled()) return none(PHOTO_UPLOADS_OFF);
  if (!uuidSchema.safeParse(sledId).success || !uuidSchema.safeParse(parent.id).success) return none("Photo not found.");
  const sled = await getSled(sledId, user.id);
  if (!sled) return none("Snowmobile not found.");
  const can = suspensionCapabilities(sled.role, { photoUploads: true });
  if (parent.kind === "setting" ? !can.canAddReferencePhotos : !can.canAddAdjustmentPhotos) {
    return none(parent.kind === "setting" ? "Only the owner or an editor can add reference photos." : "You can't add photos here.");
  }
  const supabase = await createClient();
  const table = parent.kind === "setting" ? "suspension_settings" : "suspension_revisions";
  const { data: found } = await supabase
    .from(table)
    .select("id")
    .eq("id", parent.id)
    .eq("sled_id", sledId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!found) return none("This was removed meanwhile. Reload the page and try again.");
  const { count, error } = await supabase
    .from("suspension_photos")
    .select("id", { count: "exact", head: true })
    .eq(parent.kind === "setting" ? "setting_id" : "revision_id", parent.id)
    .is("deleted_at", null);
  if (error) return none("Something went wrong. Please try again.");
  return { room: Math.max(0, MAX_SUSPENSION_PHOTOS - (count ?? 0)), canRemoveFiles: can.canRemove };
}

export async function addSuspensionPhoto(
  sledId: string,
  parent: { kind: "setting" | "revision"; id: string },
  path: string,
  position: number,
): Promise<SuspensionActionState> {
  await signedInUser();
  if (!suspensionPhotoUploadsEnabled()) return { error: PHOTO_UPLOADS_OFF };
  if (!uuidSchema.safeParse(sledId).success || !uuidSchema.safeParse(parent.id).success) return { error: "Photo not found." };
  if (!PHOTO_PATH.test(path) || !path.startsWith(`${sledId}/${parent.id}/`)) return { error: "That photo can't be used." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suspension_photos")
    .insert({
      sled_id: sledId,
      setting_id: parent.kind === "setting" ? parent.id : null,
      revision_id: parent.kind === "revision" ? parent.id : null,
      path,
      position: Math.max(0, Math.min(MAX_SUSPENSION_PHOTOS * 10, Math.trunc(position) || 0)),
    })
    .select("id")
    .single();
  if (error || !data) return failed(error, "photo");
  return done(data.id);
}

// ---------------------------------------------------------------------------
// Measurement photos (Migration 10): up to 2 per setting per configuration.
// Never creates a configuration or changes values, numbers or the active
// one. The file is uploaded from the browser into the configuration's
// folder; these record it. Add: owners, editors, mechanics. Replace and
// remove: owners and editors. Adding and replacing need the photo-upload
// feature flag; removing doesn't.
// ---------------------------------------------------------------------------
export type MeasurementPhotoCheck = { error?: string; canRemoveFiles: boolean };

/**
 * Checked BEFORE a file is uploaded: the configuration and setting still
 * exist, the user may add (or replace), and there's room (2 at most) unless
 * replacing.
 */
export async function prepareMeasurementPhoto(
  sledId: string,
  revisionId: string,
  settingId: string,
  replacing: boolean,
): Promise<MeasurementPhotoCheck> {
  const user = await signedInUser();
  const none = (error: string): MeasurementPhotoCheck => ({ error, canRemoveFiles: false });
  if (!suspensionPhotoUploadsEnabled()) return none(PHOTO_UPLOADS_OFF);
  if (![sledId, revisionId, settingId].every((id) => uuidSchema.safeParse(id).success)) return none("Photo not found.");
  const sled = await getSled(sledId, user.id);
  if (!sled) return none("Snowmobile not found.");
  const can = suspensionCapabilities(sled.role, { photoUploads: true });
  if (replacing ? !can.canReplaceMeasurementPhotos : !can.canAddMeasurementPhotos) {
    return none(replacing ? "Only the owner or an editor can replace photos." : "You can't add photos here.");
  }
  const supabase = await createClient();
  const [{ data: revision }, { data: setting }] = await Promise.all([
    supabase.from("suspension_revisions").select("id").eq("id", revisionId).eq("sled_id", sledId).is("deleted_at", null).maybeSingle(),
    supabase.from("suspension_settings").select("id").eq("id", settingId).eq("sled_id", sledId).is("deleted_at", null).maybeSingle(),
  ]);
  if (!revision || !setting) return none("This was removed meanwhile. Reload the page and try again.");
  if (!replacing) {
    const { count, error } = await supabase
      .from("sled_measurement_photos")
      .select("id", { count: "exact", head: true })
      .eq("revision_id", revisionId)
      .eq("setting_id", settingId)
      .is("deleted_at", null);
    if (error) return none(isSchemaMissing(error) ? SCHEMA_MISSING : "Something went wrong. Please try again.");
    if ((count ?? 0) >= MAX_MEASUREMENT_PHOTOS) return none(`At most ${MAX_MEASUREMENT_PHOTOS} photos per measurement.`);
  }
  return { canRemoveFiles: can.canRemove };
}

const pathFor = (sledId: string, revisionId: string, path: string) => PHOTO_PATH.test(path) && path.startsWith(`${sledId}/${revisionId}/`);

/** Record an uploaded file as the next photo of a measurement on one configuration. */
export async function addMeasurementPhoto(
  sledId: string,
  revisionId: string,
  settingId: string,
  path: string,
): Promise<SuspensionActionState> {
  await signedInUser();
  if (!suspensionPhotoUploadsEnabled()) return { error: PHOTO_UPLOADS_OFF };
  if (![sledId, revisionId, settingId].every((id) => uuidSchema.safeParse(id).success)) return { error: "Photo not found." };
  if (!pathFor(sledId, revisionId, path)) return { error: "That photo can't be used." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_suspension_measurement_photo", {
    p_revision_id: revisionId,
    p_setting_id: settingId,
    p_path: path,
  });
  const saved = data as { id?: string } | null;
  if (error || !saved?.id) return isSchemaMissing(error) ? { error: SCHEMA_MISSING } : failed(error, "photo");
  return done(saved.id);
}

/** Replace one photo of one configuration with an uploaded file (other configurations keep theirs). Owners and editors. */
export async function replaceMeasurementPhoto(
  sledId: string,
  revisionId: string,
  photoId: string,
  version: number,
  path: string,
): Promise<SuspensionActionState> {
  await signedInUser();
  if (!suspensionPhotoUploadsEnabled()) return { error: PHOTO_UPLOADS_OFF };
  if (!uuidSchema.safeParse(photoId).success || !validVersion(version)) return { error: "Reload the page and try again." };
  if (!pathFor(sledId, revisionId, path)) return { error: "That photo can't be used." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("replace_suspension_measurement_photo", {
    p_photo_id: photoId,
    p_version: version,
    p_path: path,
  });
  const saved = data as { id?: string } | null;
  if (error || !saved?.id) return isSchemaMissing(error) ? { error: SCHEMA_MISSING } : failed(error, "photo");
  return done(saved.id);
}

/** Remove one photo of one configuration (Recently Deleted; the file stays for other configurations). Owners and editors. */
export async function removeMeasurementPhoto(photoId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("sled_measurement_photos", photoId, version, true, "photo");
}

/** Remove a photo (Recently Deleted, like other records). Owners and editors. */
export async function removeSuspensionPhoto(photoId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_photos", photoId, version, true, "photo");
}
