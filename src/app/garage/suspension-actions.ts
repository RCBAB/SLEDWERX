"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { changedValues } from "@/lib/suspension/diff";
import { suspensionErrorMessage, type SuspensionSubject } from "@/lib/suspension/errors";
import { parseSnapshot } from "@/lib/suspension/queries";
import { MAX_SUSPENSION_PHOTOS, settingsInZone, isZone, type SettingValueType } from "@/lib/suspension/types";
import {
  adjustmentSchema,
  checkSettingValue,
  feedbackSchema,
  optionalUuid,
  settingSchema,
  setupSchema,
  uuidSchema,
} from "@/lib/suspension/validation";
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
  savedAt?: number;
};

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
  table: "suspension_setups" | "suspension_settings" | "suspension_feedback" | "suspension_photos",
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
// Setups
// ---------------------------------------------------------------------------

/** Create a setup (blank, or copying a revision of the same sled), or rename one. Owners and editors. */
export async function saveSetup(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const raw = formValues(formData, ["name", "notes", "copyFrom"] as const);
  const parsed = setupSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const supabase = await createClient();
  const nameError = (error: DbError) =>
    error?.code === "23505" ? { fieldErrors: { name: [suspensionErrorMessage(error, "setup")] }, values: raw } : { values: raw };

  const setupId = idFrom(formData, "setupId");
  if (setupId) {
    const version = versionFrom(formData);
    if (!version) return { error: "Reload the page and try again.", values: raw };
    const { data, error } = await supabase
      .from("suspension_setups")
      .update({ name: parsed.data.name, notes: parsed.data.notes ?? null, version })
      .eq("id", setupId)
      .select("id")
      .maybeSingle();
    if (error || !data) return failed(error, "setup", nameError(error));
    return done(setupId);
  }

  const sledId = idFrom(formData, "sledId");
  if (!sledId) return { error: "Snowmobile not found." };
  const copyFrom = optionalUuid.safeParse(raw.copyFrom);
  if (!copyFrom.success) return { fieldErrors: { copyFrom: ["Choose a revision to copy."] }, values: raw };
  const { data, error } = await supabase.rpc("create_suspension_setup", {
    p_sled_id: sledId,
    p_name: parsed.data.name,
    p_notes: parsed.data.notes,
    p_copy_from_revision_id: copyFrom.data,
  });
  const newId = (data as { setup_id?: string } | null)?.setup_id;
  if (error || !newId) return failed(error, "setup", nameError(error));

  // Made active only when asked for: a new setup never replaces the active one by itself.
  if (formData.get("activate") === "on") {
    const { error: activateError } = await supabase.rpc("activate_suspension_setup", { p_setup_id: newId });
    if (activateError) {
      refresh();
      return {
        ok: true,
        id: newId,
        savedAt: Date.now(),
        error: "The setup was saved, but it couldn't be made active. Use Set active to try again.",
      };
    }
  }
  return done(newId);
}

/** Make this setup the sled's only active one. Owners and editors. */
export async function activateSetup(setupId: string): Promise<SuspensionActionState> {
  await signedInUser();
  if (!uuidSchema.safeParse(setupId).success) return { error: "Setup not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_suspension_setup", { p_setup_id: setupId });
  if (error) return failed(error, "setup");
  return done(setupId);
}

/** Move a setup (and its history) to Recently Deleted. Refused for the active setup. Owners and editors. */
export async function deleteSetup(setupId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_setups", setupId, version, true, "setup");
}

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

/** Move a setting (and its reference photos) to Recently Deleted. History keeps its values. Owners and editors. */
export async function deleteSetting(settingId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_settings", settingId, version, true, "setting");
}

/** Bring a setting and its reference photos back (within 30 days). Owners and editors. */
export async function restoreSetting(settingId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_settings", settingId, version, false, "setting");
}

// ---------------------------------------------------------------------------
// Adjustments (revisions)
// ---------------------------------------------------------------------------

/**
 * Record an adjustment: only the values that differ from the revision the form
 * was opened on are sent; everything else carries forward in the database.
 * Mileage and hours are copies on the revision and never create a reading.
 * Owners, editors and mechanics.
 */
export async function saveAdjustment(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const setupId = idFrom(formData, "setupId");
  const baseRevisionId = idFrom(formData, "baseRevisionId");
  if (!setupId || !baseRevisionId) return { error: "Setup not found. Reload the page and try again." };

  const meta = formValues(formData, ["note", "odometer", "engineHours", "idempotencyKey"] as const);
  const typed: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith(VALUE_FIELD) && typeof value === "string") typed[key.slice(VALUE_FIELD.length)] = value;
  }
  const values = { ...meta, ...Object.fromEntries(Object.entries(typed).map(([id, v]) => [`${VALUE_FIELD}${id}`, v])) };

  const parsed = adjustmentSchema.safeParse(meta);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const supabase = await createClient();
  const [{ data: setup }, { data: base }] = await Promise.all([
    supabase.from("suspension_setups").select("sled_id").eq("id", setupId).is("deleted_at", null).maybeSingle(),
    supabase.from("suspension_revisions").select("setting_values").eq("id", baseRevisionId).eq("setup_id", setupId).maybeSingle(),
  ]);
  if (!setup || !base) return { error: "Setup not found. Reload the page and try again.", values };
  const { data: settingRows, error: settingsError } = await supabase
    .from("suspension_settings")
    .select("id, name, value_type")
    .eq("sled_id", setup.sled_id)
    .is("deleted_at", null);
  if (settingsError) return failed(settingsError, "revision", { values });
  const settings = new Map((settingRows ?? []).map((s) => [s.id, s]));

  const edited: Record<string, string | null> = {};
  const fieldErrors: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(typed)) {
    const setting = settings.get(id);
    if (!setting) continue; // removed meanwhile: nothing to change
    const check = checkSettingValue(setting.value_type as SettingValueType, value, setting.name);
    if (check.ok) edited[id] = check.value;
    else fieldErrors[`${VALUE_FIELD}${id}`] = [check.error];
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors, values };

  const changes = changedValues(parseSnapshot(base.setting_values), edited);
  if (!Object.keys(changes).length) return { error: "Nothing changed. Change at least one value to save an adjustment.", values };

  const { data, error } = await supabase.rpc("save_suspension_revision", {
    p_setup_id: setupId,
    p_base_revision_id: baseRevisionId,
    p_changes: changes,
    p_note: parsed.data.note,
    p_odometer_mi: parsed.data.odometer,
    p_engine_hours: parsed.data.engineHours,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  const revisionId = (data as { revision_id?: string } | null)?.revision_id;
  if (error || !revisionId) {
    const message = suspensionErrorMessage(error, "setup");
    const numberField = Object.keys(typed).find((id) => message === `Enter a number for ${settings.get(id)?.name}.`);
    return { error: message, fieldErrors: numberField ? { [`${VALUE_FIELD}${numberField}`]: [message] } : undefined, values };
  }
  return done(revisionId);
}

/** Save a new revision with an earlier revision's values. Nothing is erased. Owners, editors and mechanics. */
export async function restoreRevision(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const revisionId = idFrom(formData, "revisionId");
  if (!revisionId) return { error: "Revision not found. Reload the page and try again." };
  const meta = formValues(formData, ["note", "odometer", "engineHours", "idempotencyKey"] as const);
  const parsed = adjustmentSchema.safeParse(meta);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: meta };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("restore_suspension_revision", {
    p_revision_id: revisionId,
    p_note: parsed.data.note,
    p_odometer_mi: parsed.data.odometer,
    p_engine_hours: parsed.data.engineHours,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  const newId = (data as { revision_id?: string } | null)?.revision_id;
  if (error || !newId) return failed(error, "revision", { values: meta });
  return done(newId);
}

// ---------------------------------------------------------------------------
// Feedback (several per revision)
// ---------------------------------------------------------------------------

/** Add feedback to a revision, or edit it (owners and editors any, mechanics their own). */
export async function saveFeedback(_prev: SuspensionActionState, formData: FormData): Promise<SuspensionActionState> {
  await signedInUser();
  const raw = formValues(formData, ["rating", "riddenOn", "note"] as const);
  const parsed = feedbackSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const dateError = futureDateError(parsed.data.riddenOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { riddenOn: [dateError] }, values: raw };
  const fields = { rating: parsed.data.rating, ridden_on: parsed.data.riddenOn, note: parsed.data.note ?? null };
  const supabase = await createClient();

  const feedbackId = idFrom(formData, "feedbackId");
  if (feedbackId) {
    const version = versionFrom(formData);
    if (!version) return { error: "Reload the page and try again.", values: raw };
    const { data, error } = await supabase
      .from("suspension_feedback")
      .update({ ...fields, version })
      .eq("id", feedbackId)
      .select("id")
      .maybeSingle();
    if (error || !data) return failed(error, "feedback", { values: raw });
    return done(feedbackId);
  }

  const revisionId = idFrom(formData, "revisionId");
  const sledId = idFrom(formData, "sledId");
  if (!revisionId || !sledId) return { error: "Revision not found. Reload the page and try again." };
  const { data, error } = await supabase
    .from("suspension_feedback")
    .insert({ revision_id: revisionId, sled_id: sledId, ...fields })
    .select("id")
    .single();
  if (error || !data) return failed(error, "feedback", { values: raw });
  return done(data.id);
}

/** Remove feedback (Recently Deleted). Owners and editors. */
export async function deleteFeedback(feedbackId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_feedback", feedbackId, version, true, "feedback");
}

// ---------------------------------------------------------------------------
// Photos (the file is uploaded from the browser with the user's own session;
// this records it). Reference photos: owners and editors. Adjustment photos:
// owners, editors and mechanics.
// ---------------------------------------------------------------------------
export async function addSuspensionPhoto(
  sledId: string,
  parent: { kind: "setting" | "revision"; id: string },
  path: string,
  position: number,
): Promise<SuspensionActionState> {
  await signedInUser();
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

/** Remove a photo (Recently Deleted, like other records). Owners and editors. */
export async function removeSuspensionPhoto(photoId: string, version: number): Promise<SuspensionActionState> {
  return setDeleted("suspension_photos", photoId, version, true, "photo");
}
