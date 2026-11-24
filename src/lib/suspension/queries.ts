import "server-only";

import { PHOTO_URL_TTL } from "@/lib/sleds/constants";
import { formatDate } from "@/lib/sleds/format";
import { createClient } from "@/lib/supabase/server";

import { latestFeedback } from "./diff";
import {
  FEEDBACK_SHORT,
  NO_EQUIPMENT,
  configName,
  isCarbideLength,
  isSkiModel,
  isTrailCondition,
  type Equipment,
  RECOVERY_DAYS,
  daysLeftToRestore,
  SUSPENSION_PHOTO_BUCKET,
  ZONE_LABEL,
  isInputMethods,
  isZone,
  sortSettings,
  type ActiveSuspension,
  type DeletedSuspensionItem,
  type FeedbackRating,
  type SettingValueType,
  type Snapshot,
  type SnapshotEntry,
  type SuspensionData,
  type SuspensionFeedback,
  type SuspensionPhoto,
  type SuspensionRevision,
  type SuspensionSetting,
  type SuspensionSetup,
  type TrailCondition,
} from "./types";

// Every query runs as the signed-in user, so Row Level Security decides what
// is visible: the sled's owner and the people it is shared with. Deleted rows
// are only visible to owners and editors (Recently Deleted).

type Client = Awaited<ReturnType<typeof createClient>>;

/** How many revisions of a sled the page loads (newest first). */
export const REVISION_LIMIT = 500;

const SETTING_COLUMNS = "id, sled_id, name, zone, value_type, unit, position, notes, version";
/** With Migration 12's input methods (falls back to SETTING_COLUMNS before it is applied). */
const SETTING_COLUMNS_12 = `${SETTING_COLUMNS}, input_methods`;
const REVISION_COLUMNS =
  "id, setup_id, revision_number, config_number, ski_model, carbide_length, based_on_revision_id, setting_values, note, odometer_mi, engine_hours, restored_from_revision_id, created_at, created_by";
const FEEDBACK_COLUMNS = "id, revision_id, ridden_on, rating, conditions, high_temp_f, note, created_by, created_at, version";

/**
 * Thrown when the database doesn't have Migration 9 (Quick Tune) yet, e.g. a
 * preview deployment that shares a database still at Migration 8. Pages show a
 * notice instead of failing.
 */
export class QuickTuneSchemaMissing extends Error {
  constructor() {
    super("The suspension database update (Migration 9) has not been applied yet.");
  }
}

type DbError = { code?: string; message?: string } | null | undefined;

/** Unknown column or table: the schema is older than this code. */
export function isSchemaMissing(error: DbError): boolean {
  return Boolean(error && ["42703", "42P01", "PGRST204", "PGRST205", "PGRST200"].includes(error.code ?? ""));
}

export function toEquipment(ski: string | null | undefined, carbide: string | null | undefined): Equipment {
  return { ski: isSkiModel(ski) ? ski : null, carbide: isCarbideLength(carbide) ? carbide : null };
}

function toConditions(raw: unknown): TrailCondition[] {
  return Array.isArray(raw) ? raw.filter(isTrailCondition) : [];
}

/** A stored snapshot, keeping only well-formed entries. */
export function parseSnapshot(raw: unknown): Snapshot {
  const values: Snapshot = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return values;
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value !== "string" || typeof e.name !== "string" || !isZone(e.zone)) continue;
    values[id] = {
      value: e.value,
      name: e.name,
      zone: e.zone,
      unit: typeof e.unit === "string" ? e.unit : null,
      type: (e.type === "text" ? "text" : "number") as SnapshotEntry["type"],
    };
  }
  return values;
}

async function signedUrls(supabase: Client, paths: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (!paths.length) return urls;
  const { data } = await supabase.storage.from(SUSPENSION_PHOTO_BUCKET).createSignedUrls(paths, PHOTO_URL_TTL);
  for (const item of data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
  return urls;
}

/** Display names of the people who saved things ("You" for the viewer). */
async function names(supabase: Client, ids: (string | null)[], userId: string): Promise<(id: string | null) => string> {
  const others = [...new Set(ids.filter((id): id is string => Boolean(id) && id !== userId))];
  const map = new Map<string, string>();
  if (others.length) {
    const { data } = await supabase.from("profiles").select("id, display_name").in("id", others);
    for (const p of data ?? []) if (p.display_name?.trim()) map.set(p.id, p.display_name.trim());
  }
  return (id) => (id === userId ? "You" : (id && map.get(id)) || "Someone with access");
}

type SettingRow = Parameters<typeof toSetting>[0] & { sled_id: string };

function toSetting(row: {
  id: string;
  name: string;
  zone: string;
  value_type: string;
  unit: string | null;
  position: number;
  notes: string | null;
  version: number;
  input_methods?: string | null;
}): SuspensionSetting | null {
  if (!isZone(row.zone)) return null;
  return {
    id: row.id,
    name: row.name,
    zone: row.zone,
    valueType: (row.value_type === "text" ? "text" : "number") as SettingValueType,
    inputMethods: isInputMethods(row.input_methods) ? row.input_methods : "measurement",
    unit: row.unit,
    position: row.position,
    notes: row.notes,
    version: row.version,
    photos: [],
  };
}

/** The current (not deleted) settings of some sleds, in diagram order. */
async function loadSettings(supabase: Client, sledIds: string[]): Promise<Map<string, SuspensionSetting[]>> {
  const bySled = new Map<string, SuspensionSetting[]>(sledIds.map((id) => [id, []]));
  if (!sledIds.length) return bySled;
  const load = async (columns: string) => {
    const { data, error } = await supabase.from("suspension_settings").select(columns).in("sled_id", sledIds).is("deleted_at", null);
    return { data: data as unknown as SettingRow[] | null, error };
  };
  let { data, error } = await load(SETTING_COLUMNS_12);
  if (isSchemaMissing(error)) ({ data, error } = await load(SETTING_COLUMNS));
  if (error) throw new Error("Could not load suspension settings.");
  for (const row of data ?? []) {
    const setting = toSetting(row);
    if (setting) bySled.get(row.sled_id)?.push(setting);
  }
  for (const [id, list] of bySled) bySled.set(id, sortSettings(list));
  return bySled;
}

/**
 * Everything the Suspension page shows: the settings list (with reference
 * photos), the setups, every revision of the sled (with feedback and
 * adjustment photos) and, for owners and editors, Recently Deleted.
 */
export async function getSuspensionData(sledId: string, userId: string, includeDeleted: boolean): Promise<SuspensionData> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - RECOVERY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [settingsBySled, setups, revisions, deletedSetups, deletedSettings, deletedFeedback, state] = await Promise.all([
    loadSettings(supabase, [sledId]),
    supabase
      .from("suspension_setups")
      .select("id, name, notes, is_active, version, created_at")
      .eq("sled_id", sledId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("suspension_revisions")
      .select(REVISION_COLUMNS)
      .eq("sled_id", sledId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("revision_number", { ascending: false })
      .limit(REVISION_LIMIT),
    includeDeleted
      ? supabase
          .from("suspension_setups")
          .select("id, name, deleted_at, version")
          .eq("sled_id", sledId)
          .not("deleted_at", "is", null)
          .gt("deleted_at", cutoff)
      : Promise.resolve({ data: [], error: null }),
    includeDeleted
      ? supabase
          .from("suspension_settings")
          .select("id, name, zone, deleted_at, version")
          .eq("sled_id", sledId)
          .not("deleted_at", "is", null)
          .gt("deleted_at", cutoff)
      : Promise.resolve({ data: [], error: null }),
    includeDeleted
      ? supabase
          .from("suspension_feedback")
          .select("id, revision_id, rating, ridden_on, note, created_by, deleted_at, version")
          .eq("sled_id", sledId)
          .not("deleted_at", "is", null)
          .gt("deleted_at", cutoff)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("sled_suspension_state").select("active_revision_id, ski_model, carbide_length").eq("sled_id", sledId).maybeSingle(),
  ]);
  if (isSchemaMissing(revisions.error) || isSchemaMissing(state.error)) throw new QuickTuneSchemaMissing();
  if (setups.error || revisions.error || deletedSetups.error || deletedSettings.error || deletedFeedback.error || state.error) {
    throw new Error("Could not load suspension setups.");
  }

  const settings = settingsBySled.get(sledId) ?? [];
  const revisionRows = revisions.data ?? [];
  const revisionIds = revisionRows.map((r) => r.id);
  const settingIds = settings.map((s) => s.id);

  const [feedback, photos] = await Promise.all([
    revisionIds.length
      ? supabase.from("suspension_feedback").select(FEEDBACK_COLUMNS).eq("sled_id", sledId).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    revisionIds.length || settingIds.length
      ? supabase
          .from("suspension_photos")
          .select("id, setting_id, revision_id, path, position, version, created_by, created_at")
          .eq("sled_id", sledId)
          .is("deleted_at", null)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (feedback.error || photos.error) throw new Error("Could not load suspension history.");

  // Measurement photos (Migration 10); without the table, the feature is simply off.
  const measurement = revisionIds.length
    ? await supabase
        .from("sled_measurement_photos")
        .select("id, revision_id, setting_id, slot, path, version, created_by, created_at")
        .eq("sled_id", sledId)
        .is("deleted_at", null)
    : { data: [], error: null };
  const measurementPhotos = !isSchemaMissing(measurement.error);
  if (measurement.error && measurementPhotos) throw new Error("Could not load measurement photos.");
  const measurementRows = measurement.error ? [] : (measurement.data ?? []);

  const photoRows = photos.data ?? [];
  const feedbackRows = feedback.data ?? [];
  const [urls, nameOf] = await Promise.all([
    signedUrls(supabase, [...new Set([...photoRows.map((p) => p.path), ...measurementRows.map((p) => p.path)])]),
    names(
      supabase,
      [
        ...revisionRows.map((r) => r.created_by),
        ...feedbackRows.map((f) => f.created_by),
        ...(deletedFeedback.data ?? []).map((f) => f.created_by),
      ],
      userId,
    ),
  ]);

  const photo = (p: (typeof photoRows)[number]): SuspensionPhoto => ({
    id: p.id,
    path: p.path,
    url: urls.get(p.path) ?? null,
    version: p.version,
    createdBy: p.created_by,
  });
  for (const setting of settings) setting.photos = photoRows.filter((p) => p.setting_id === setting.id).map(photo);

  const numberById = new Map(revisionRows.map((r) => [r.id, r.revision_number]));
  const feedbackByRevision = new Map<string, SuspensionFeedback[]>();
  for (const f of feedbackRows) {
    const list = feedbackByRevision.get(f.revision_id) ?? [];
    list.push({
      id: f.id,
      revisionId: f.revision_id,
      riddenOn: f.ridden_on,
      rating: f.rating as FeedbackRating,
      conditions: toConditions(f.conditions),
      highTempF: f.high_temp_f,
      note: f.note,
      createdBy: f.created_by,
      createdByName: nameOf(f.created_by),
      createdAt: f.created_at,
      version: f.version,
    });
    feedbackByRevision.set(f.revision_id, list);
  }

  const revisionList: SuspensionRevision[] = revisionRows.map((r) => ({
    id: r.id,
    setupId: r.setup_id,
    number: r.revision_number,
    configNumber: r.config_number,
    equipment: toEquipment(r.ski_model, r.carbide_length),
    basedOnId: r.based_on_revision_id,
    values: parseSnapshot(r.setting_values),
    note: r.note,
    odometer: r.odometer_mi == null ? null : Number(r.odometer_mi),
    engineHours: r.engine_hours == null ? null : Number(r.engine_hours),
    restoredFrom: r.restored_from_revision_id
      ? { id: r.restored_from_revision_id, number: numberById.get(r.restored_from_revision_id) ?? 0 }
      : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: nameOf(r.created_by),
    feedback: (feedbackByRevision.get(r.id) ?? []).sort(
      (a, b) => b.riddenOn.localeCompare(a.riddenOn) || b.createdAt.localeCompare(a.createdAt),
    ),
    photos: photoRows.filter((p) => p.revision_id === r.id).map(photo),
    measurementPhotos: measurementRows
      .filter((m) => m.revision_id === r.id)
      .map((m) => ({
        id: m.id,
        revisionId: m.revision_id,
        settingId: m.setting_id,
        slot: (m.slot === 2 ? 2 : 1) as 1 | 2,
        path: m.path,
        url: urls.get(m.path) ?? null,
        version: m.version,
        createdBy: m.created_by,
        createdAt: m.created_at,
      }))
      .sort((a, b) => a.slot - b.slot),
  }));

  const setupList: SuspensionSetup[] = (setups.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    notes: s.notes,
    isActive: s.is_active,
    version: s.version,
    createdAt: s.created_at,
  }));

  const deleted: DeletedSuspensionItem[] = [
    ...(deletedSetups.data ?? []).map((s) => ({
      kind: "setup" as const,
      id: s.id,
      name: s.name,
      detail: "Setup, with its history",
      deletedAt: s.deleted_at!,
      daysLeft: daysLeftToRestore(s.deleted_at!),
      version: s.version,
    })),
    ...(deletedSettings.data ?? []).map((s) => ({
      kind: "setting" as const,
      id: s.id,
      name: s.name,
      detail: isZone(s.zone) ? `Setting · ${ZONE_LABEL[s.zone]}` : "Setting",
      deletedAt: s.deleted_at!,
      daysLeft: daysLeftToRestore(s.deleted_at!),
      version: s.version,
    })),
    // Only feedback removed on its own: feedback that went with its setup comes back with the setup.
    ...(deletedFeedback.data ?? []).flatMap((f) => {
      const revision = revisionRows.find((r) => r.id === f.revision_id);
      if (!revision) return [];
      const rating = FEEDBACK_SHORT[f.rating as FeedbackRating] ?? f.rating;
      const note = f.note ? ` · “${f.note.length > 60 ? `${f.note.slice(0, 57)}…` : f.note}”` : "";
      return [
        {
          kind: "feedback" as const,
          id: f.id,
          name: `${rating} · ${configName(revision.config_number)}`,
          detail: `Ride evaluation · ridden ${formatDate(f.ridden_on)} · ${nameOf(f.created_by)}${note}`,
          deletedAt: f.deleted_at!,
          daysLeft: daysLeftToRestore(f.deleted_at!),
          version: f.version,
        },
      ];
    }),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

  const activeRevisionId =
    state.data?.active_revision_id && revisionList.some((r) => r.id === state.data!.active_revision_id)
      ? state.data.active_revision_id
      : null;
  return {
    sledId,
    settings,
    setups: setupList,
    revisions: revisionList,
    deleted,
    activeRevisionId,
    installed: state.data ? toEquipment(state.data.ski_model, state.data.carbide_length) : NO_EQUIPMENT,
    measurementPhotos,
  };
}

/**
 * Each sled's suspension at a glance: the active configuration (if any) with
 * its newest ride evaluation, the installed skis and carbides, and the
 * current settings. For the sled page and the Garage Board. Returns an empty
 * map (nothing shown) if the database doesn't have Migration 9 yet.
 */
export async function getActiveSuspensions(sledIds: string[]): Promise<Map<string, ActiveSuspension>> {
  const result = new Map<string, ActiveSuspension>();
  if (!sledIds.length) return result;
  const supabase = await createClient();
  const { data: states, error } = await supabase
    .from("sled_suspension_state")
    .select("sled_id, active_revision_id, ski_model, carbide_length")
    .in("sled_id", sledIds);
  if (isSchemaMissing(error)) return result;
  if (error) throw new Error("Could not load suspension setups.");

  const activeIds = (states ?? []).flatMap((s) => (s.active_revision_id ? [s.active_revision_id] : []));
  const [settingsBySled, revisions, feedback] = await Promise.all([
    loadSettings(supabase, sledIds),
    activeIds.length
      ? supabase
          .from("suspension_revisions")
          .select("id, sled_id, config_number, ski_model, carbide_length, setting_values, created_at")
          .in("id", activeIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    activeIds.length
      ? supabase
          .from("suspension_feedback")
          .select("revision_id, rating, conditions, ridden_on, created_at")
          .in("revision_id", activeIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (revisions.error || feedback.error) throw new Error("Could not load suspension setups.");

  for (const sledId of sledIds) {
    const state = (states ?? []).find((s) => s.sled_id === sledId);
    const revision = (revisions.data ?? []).find((r) => r.id === state?.active_revision_id);
    const newest = revision
      ? latestFeedback(
          (feedback.data ?? [])
            .filter((f) => f.revision_id === revision.id)
            .map((f) => ({
              rating: f.rating as FeedbackRating,
              riddenOn: f.ridden_on,
              createdAt: f.created_at,
              conditions: toConditions(f.conditions),
            })),
        )
      : undefined;
    result.set(sledId, {
      active: revision
        ? {
            revisionId: revision.id,
            configNumber: revision.config_number,
            changedAt: revision.created_at,
            values: parseSnapshot(revision.setting_values),
            equipment: toEquipment(revision.ski_model, revision.carbide_length),
            latestFeedback: newest ? { rating: newest.rating, riddenOn: newest.riddenOn, conditions: newest.conditions } : null,
          }
        : null,
      installed: state ? toEquipment(state.ski_model, state.carbide_length) : NO_EQUIPMENT,
      settings: settingsBySled.get(sledId) ?? [],
    });
  }
  return result;
}
