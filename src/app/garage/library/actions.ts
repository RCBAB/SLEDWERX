"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { packageNameSchema, taskNameSchema } from "@/lib/service/validation";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { sledIdSchema } from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf } from "@/lib/validation/auth";

// Library changes run as the signed-in user: RLS and the library guards
// decide what is allowed (your own tasks and packages; sled tasks for owners
// and editors). Removals are soft deletes, kept in the audit history.

export type LibraryActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  ok?: boolean;
  savedAt?: number;
};

type Table = "maintenance_tasks" | "maintenance_packages" | "maintenance_package_tasks";

async function signedIn() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=%2Fgarage%2Flibrary");
  return user;
}

function id(formData: FormData, key = "id") {
  const parsed = sledIdSchema.safeParse(formData.get(key));
  return parsed.success ? parsed.data : null;
}

function version(formData: FormData) {
  const v = Number(formData.get("version"));
  return Number.isInteger(v) && v > 0 ? v : null;
}

function nameMessage(error: { code?: string; message?: string } | null, what: string) {
  if (error?.code === "23505") return `You already have a ${what} with that name.`;
  return sledErrorMessage(error, what);
}

function done(): LibraryActionState {
  refresh();
  return { ok: true, savedAt: Date.now() };
}

async function rename(table: Table, formData: FormData, what: string): Promise<LibraryActionState> {
  await signedIn();
  const rowId = id(formData);
  const v = version(formData);
  const parsed = taskNameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  if (!rowId || !v) return { error: `This ${what} could not be found.` };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table as "maintenance_tasks")
    .update({ name: parsed.data.name, version: v })
    .eq("id", rowId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: nameMessage(error ?? { code: "42501" }, what) };
  return done();
}

async function remove(table: Table, formData: FormData, what: string): Promise<LibraryActionState> {
  await signedIn();
  const rowId = id(formData);
  const v = version(formData);
  if (!rowId || !v) return { error: `This ${what} could not be found.` };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: new Date().toISOString(), version: v })
    .eq("id", rowId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, what) };
  return done();
}

// ---------------------------------------------------------------------------
// Tasks: your library, or one snowmobile's tasks
// ---------------------------------------------------------------------------
export async function createTask(_prev: LibraryActionState, formData: FormData): Promise<LibraryActionState> {
  await signedIn();
  const parsed = taskNameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const sledId = formData.get("sledId") ? id(formData, "sledId") : null;
  if (formData.get("sledId") && !sledId) return { error: "Snowmobile not found." };

  const supabase = await createClient();
  // The database sets owner_id for library tasks and checks sled permissions.
  const { error } = await supabase
    .from("maintenance_tasks")
    .insert(sledId ? { sled_id: sledId, name: parsed.data.name } : { name: parsed.data.name });
  if (error) return { error: nameMessage(error, "task") };
  return done();
}

export async function renameTask(_prev: LibraryActionState, formData: FormData) {
  return rename("maintenance_tasks", formData, "task");
}

export async function deleteTask(_prev: LibraryActionState, formData: FormData) {
  return remove("maintenance_tasks", formData, "task");
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------
export async function createPackage(_prev: LibraryActionState, formData: FormData): Promise<LibraryActionState> {
  await signedIn();
  const parsed = packageNameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.from("maintenance_packages").insert({ name: parsed.data.name });
  if (error) return { error: nameMessage(error, "package") };
  return done();
}

export async function renamePackage(_prev: LibraryActionState, formData: FormData) {
  return rename("maintenance_packages", formData, "package");
}

export async function deletePackage(_prev: LibraryActionState, formData: FormData) {
  return remove("maintenance_packages", formData, "package");
}

export async function addPackageTask(_prev: LibraryActionState, formData: FormData): Promise<LibraryActionState> {
  const user = await signedIn();
  const packageId = id(formData, "packageId");
  const taskId = id(formData, "taskId");
  if (!packageId) return { error: "This package could not be found." };
  if (!taskId) return { fieldErrors: { taskId: ["Choose a task to add."] } };

  const supabase = await createClient();
  const { data: last } = await supabase
    .from("maintenance_package_tasks")
    .select("position")
    .eq("package_id", packageId)
    .is("deleted_at", null)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  // The database sets owner_id and checks the task is in your own library.
  const { error } = await supabase.from("maintenance_package_tasks").insert({
    package_id: packageId,
    task_id: taskId,
    owner_id: user.id,
    position: (last?.position ?? -1) + 1,
  });
  if (error) {
    return { error: error.code === "23505" ? "That task is already in this package." : sledErrorMessage(error, "package") };
  }
  return done();
}

export async function removePackageTask(_prev: LibraryActionState, formData: FormData) {
  return remove("maintenance_package_tasks", formData, "package task");
}

/** Moves a task up or down within its package (swaps positions). */
export async function movePackageTask(_prev: LibraryActionState, formData: FormData): Promise<LibraryActionState> {
  await signedIn();
  const itemId = id(formData);
  const packageId = id(formData, "packageId");
  const direction = formData.get("direction") === "up" ? -1 : 1;
  if (!itemId || !packageId) return { error: "This package could not be found." };

  const supabase = await createClient();
  const { data: items, error } = await supabase
    .from("maintenance_package_tasks")
    .select("id, position, version, created_at")
    .eq("package_id", packageId)
    .is("deleted_at", null)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error || !items) return { error: sledErrorMessage(error, "package") };

  const index = items.findIndex((i) => i.id === itemId);
  const other = items[index + direction];
  if (index < 0 || !other) return done();

  // Renumber the whole list in its new order, so positions stay unique.
  const order = [...items];
  [order[index], order[index + direction]] = [order[index + direction], order[index]];
  for (const [position, item] of order.entries()) {
    if (item.position === position) continue;
    const { error: moveError } = await supabase
      .from("maintenance_package_tasks")
      .update({ position, version: item.version })
      .eq("id", item.id);
    if (moveError) return { error: sledErrorMessage(moveError, "package") };
  }
  return done();
}
