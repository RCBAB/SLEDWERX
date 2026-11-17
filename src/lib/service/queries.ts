import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { SledRole } from "@/lib/sleds/constants";
import { sledIdSchema } from "@/lib/sleds/validation";

import type { ServiceCategory } from "./constants";

// Every query runs as the signed-in user, so Row Level Security decides what
// is visible. Nothing here bypasses it.

export type ServiceTask = { id: string; taskId: string | null; name: string; note: string | null };
export type ServicePart = {
  id: string;
  name: string;
  partNumber: string | null;
  brand: string | null;
  supplier: string | null;
  quantity: number;
  unitCost: number | null;
};

export type ServiceRecord = {
  id: string;
  sledId: string;
  performedOn: string;
  title: string;
  category: ServiceCategory | null;
  doneBy: string | null;
  notes: string | null;
  laborCost: number | null;
  otherCost: number | null;
  readingId: string | null;
  odometer: number | null;
  engineHours: number | null;
  createdBy: string | null;
  editedAt: string | null;
  version: number;
  tasks: ServiceTask[];
  parts: ServicePart[];
  costs: { parts: number; labor: number; other: number; total: number };
};

const ENTRY_COLUMNS =
  "id, sled_id, performed_on, title, category, done_by, notes, labor_cost, other_cost, reading_id, created_at, created_by, edited_at, version";

type EntryRow = {
  id: string;
  sled_id: string;
  performed_on: string;
  title: string;
  category: string | null;
  done_by: string | null;
  notes: string | null;
  labor_cost: number | null;
  other_cost: number | null;
  reading_id: string | null;
  created_by: string | null;
  edited_at: string | null;
  version: number;
};

async function assemble(entries: EntryRow[]): Promise<ServiceRecord[]> {
  if (!entries.length) return [];
  const supabase = await createClient();
  const ids = entries.map((e) => e.id);
  const readingIds = entries.flatMap((e) => (e.reading_id ? [e.reading_id] : []));

  const [tasks, parts, readings, costs] = await Promise.all([
    supabase
      .from("maintenance_entry_tasks")
      .select("id, entry_id, task_id, task_name, note, position")
      .in("entry_id", ids)
      .is("deleted_at", null)
      .order("position", { ascending: true }),
    supabase
      .from("maintenance_entry_parts")
      .select("id, entry_id, name, part_number, brand, supplier, quantity, unit_cost, created_at")
      .in("entry_id", ids)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    readingIds.length
      ? supabase.from("sled_readings").select("id, odometer_mi, engine_hours").in("id", readingIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("maintenance_entry_costs").select("entry_id, parts_cost, labor_cost, other_cost, total_cost").in("entry_id", ids),
  ]);
  if (tasks.error || parts.error || readings.error || costs.error) {
    throw new Error("Could not load the service history.");
  }

  const readingById = new Map((readings.data ?? []).map((r) => [r.id, r]));
  const costById = new Map((costs.data ?? []).map((c) => [c.entry_id, c]));

  return entries.map((e) => {
    const reading = e.reading_id ? readingById.get(e.reading_id) : undefined;
    const cost = costById.get(e.id);
    return {
      id: e.id,
      sledId: e.sled_id,
      performedOn: e.performed_on,
      title: e.title,
      category: e.category as ServiceCategory | null,
      doneBy: e.done_by,
      notes: e.notes,
      laborCost: e.labor_cost,
      otherCost: e.other_cost,
      readingId: e.reading_id,
      odometer: reading?.odometer_mi ?? null,
      engineHours: reading?.engine_hours ?? null,
      createdBy: e.created_by,
      editedAt: e.edited_at,
      version: e.version,
      tasks: (tasks.data ?? [])
        .filter((t) => t.entry_id === e.id)
        .map((t) => ({ id: t.id, taskId: t.task_id, name: t.task_name, note: t.note })),
      parts: (parts.data ?? [])
        .filter((p) => p.entry_id === e.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          partNumber: p.part_number,
          brand: p.brand,
          supplier: p.supplier,
          quantity: Number(p.quantity),
          unitCost: p.unit_cost == null ? null : Number(p.unit_cost),
        })),
      costs: {
        parts: Number(cost?.parts_cost ?? 0),
        labor: Number(cost?.labor_cost ?? 0),
        other: Number(cost?.other_cost ?? 0),
        total: Number(cost?.total_cost ?? 0),
      },
    };
  });
}

/** A sled's service history, newest first. */
export async function listServiceRecords(sledId: string): Promise<ServiceRecord[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_entries")
    .select(ENTRY_COLUMNS)
    .eq("sled_id", sledId)
    .is("deleted_at", null)
    .order("performed_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not load the service history.");
  return assemble(data ?? []);
}

/** One service record of a sled, or null if it isn't visible or doesn't exist. */
export async function getServiceRecord(sledId: string, entryId: string): Promise<ServiceRecord | null> {
  if (!sledIdSchema.safeParse(entryId).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_entries")
    .select(ENTRY_COLUMNS)
    .eq("id", entryId)
    .eq("sled_id", sledId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Could not load this service record.");
  if (!data) return null;
  const [record] = await assemble([data]);
  return record ?? null;
}

export type TaskOption = { id: string; name: string; scope: "library" | "sled" };

/**
 * Tasks that can be used on a sled: the sled's own tasks, and the sled
 * owner's library tasks (all of them for the owner; for shared users, only
 * those already used on this sled, which is what RLS lets them see).
 */
export async function taskOptionsForSled(sled: { id: string; ownerId: string }): Promise<TaskOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("id, name, sled_id, owner_id")
    .is("deleted_at", null)
    .or(`sled_id.eq.${sled.id},owner_id.eq.${sled.ownerId}`)
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load your tasks.");
  return (data ?? []).map((t) => ({ id: t.id, name: t.name, scope: t.sled_id ? "sled" : "library" }));
}

/** taskOptionsForSled() for several sleds in one query (Garage Board), with the same rules. */
export async function taskOptionsForSleds(sleds: { id: string; ownerId: string }[]): Promise<Map<string, TaskOption[]>> {
  const options = new Map<string, TaskOption[]>(sleds.map((s) => [s.id, []]));
  if (!sleds.length) return options;
  const supabase = await createClient();
  const owners = [...new Set(sleds.map((s) => s.ownerId))];
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("id, name, sled_id, owner_id")
    .is("deleted_at", null)
    .or(`sled_id.in.(${sleds.map((s) => s.id).join(",")}),owner_id.in.(${owners.join(",")})`)
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load your tasks.");
  for (const sled of sleds) {
    options.set(
      sled.id,
      (data ?? [])
        .filter((t) => t.sled_id === sled.id || (t.sled_id == null && t.owner_id === sled.ownerId))
        .map((t) => ({ id: t.id, name: t.name, scope: t.sled_id ? "sled" : "library" })),
    );
  }
  return options;
}

export type LibraryTask = { id: string; name: string; version: number };
export type PackageItem = { id: string; taskId: string; name: string; position: number; version: number };
export type MaintenancePackage = { id: string; name: string; version: number; items: PackageItem[] };

/** The user's own task library. */
export async function listLibraryTasks(userId: string): Promise<LibraryTask[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("id, name, version")
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load your tasks.");
  return data ?? [];
}

/** The user's packages with their tasks in order. */
export async function listPackages(userId: string): Promise<MaintenancePackage[]> {
  const supabase = await createClient();
  const [packages, items, tasks] = await Promise.all([
    supabase.from("maintenance_packages").select("id, name, version").eq("owner_id", userId).is("deleted_at", null).order("name"),
    supabase
      .from("maintenance_package_tasks")
      .select("id, package_id, task_id, position, version, created_at")
      .eq("owner_id", userId)
      .is("deleted_at", null)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase.from("maintenance_tasks").select("id, name").eq("owner_id", userId).is("deleted_at", null),
  ]);
  if (packages.error || items.error || tasks.error) throw new Error("Could not load your packages.");
  const taskName = new Map((tasks.data ?? []).map((t) => [t.id, t.name]));
  return (packages.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    items: (items.data ?? [])
      .filter((i) => i.package_id === p.id && taskName.has(i.task_id))
      .map((i) => ({ id: i.id, taskId: i.task_id, name: taskName.get(i.task_id)!, position: i.position, version: i.version })),
  }));
}

export type SledTaskGroup = { sledId: string; sledName: string; role: SledRole; tasks: LibraryTask[] };

/** Snowmobile-specific tasks, grouped by sled, for sleds the user can see. */
export async function listSledTasks(sleds: { id: string; name: string; role: SledRole }[]): Promise<SledTaskGroup[]> {
  if (!sleds.length) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("id, name, version, sled_id")
    .in(
      "sled_id",
      sleds.map((s) => s.id),
    )
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) throw new Error("Could not load snowmobile tasks.");
  return sleds.map((s) => ({
    sledId: s.id,
    sledName: s.name,
    role: s.role,
    tasks: (data ?? []).filter((t) => t.sled_id === s.id).map(({ id, name, version }) => ({ id, name, version })),
  }));
}

/** The user's role on each sled they can see (for the library page). */
export async function sledRoles(userId: string): Promise<Map<string, SledRole>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sled_shares")
    .select("sled_id, role")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .is("suspended_at", null);
  return new Map((data ?? []).map((s) => [s.sled_id, s.role]));
}
