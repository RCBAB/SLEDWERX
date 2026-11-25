"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import type { ServiceTaskInput } from "@/lib/service/form";
import { taskOptionsForSled } from "@/lib/service/queries";
import { createServiceSchema, serviceReading, updateServiceSchema } from "@/lib/service/validation";
import { sledErrorMessage } from "@/lib/sleds/errors";
import { getSled } from "@/lib/sleds/queries";
import { futureDateError, sledIdSchema } from "@/lib/sleds/validation";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, formValues } from "@/lib/validation/auth";

// Every write runs as the signed-in user through the database functions
// save_maintenance_entry / update_maintenance_entry, so Row Level Security,
// guards, mileage validation, versioning and audit logging all apply. The
// checks here only give friendlier messages.

export type ServiceActionState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string | undefined>;
  ok?: boolean;
  entryId?: string;
  savedAt?: number;
};

const FIELDS = [
  "title",
  "category",
  "performedOn",
  "mileageUnknown",
  "odometer",
  "engineHours",
  "doneBy",
  "notes",
  "laborCost",
  "otherCost",
  "tasks",
  "parts",
  "idempotencyKey",
  "version",
] as const;

async function signedInUser(next: string) {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

function idFrom(formData: FormData, key: string): string | null {
  const parsed = sledIdSchema.safeParse(formData.get(key));
  return parsed.success ? parsed.data : null;
}

/** Puts database messages next to the field they concern. */
function fieldFor(message: string): ServiceActionState["fieldErrors"] {
  if (message.startsWith("Odometer")) return { odometer: [message] };
  if (message.startsWith("Engine-hour")) return { engineHours: [message] };
  if (message.startsWith("The service date") || message.startsWith("The reading date")) return { performedOn: [message] };
  return undefined;
}

/**
 * Tasks as the database expects them. A task id the sled can't use (for
 * example a package task from another user's library) is saved as free text,
 * so the work is still recorded.
 */
function tasksForDatabase(tasks: ServiceTaskInput[], usable: Set<string>, names: Map<string, string>) {
  return tasks.map((t) => {
    const base = t.id ? { id: t.id } : {};
    if (t.taskId && usable.has(t.taskId)) return { ...base, task_id: t.taskId, task_name: names.get(t.taskId) ?? t.name };
    return { ...base, task_name: t.name || names.get(t.taskId ?? "") || "Task" };
  });
}

function partsForDatabase(parts: { id?: string; name: string; partNumber?: string; brand?: string; supplier?: string; quantity: number; unitCost?: number }[]) {
  return parts.map((p) => ({
    ...(p.id ? { id: p.id } : {}),
    name: p.name,
    part_number: p.partNumber ?? null,
    brand: p.brand ?? null,
    supplier: p.supplier ?? null,
    quantity: p.quantity,
    unit_cost: p.unitCost ?? null,
  }));
}

async function usableTasks(sled: { id: string; ownerId: string }) {
  const options = await taskOptionsForSled(sled);
  return { usable: new Set(options.map((o) => o.id)), names: new Map(options.map((o) => [o.id, o.name])) };
}

// ---------------------------------------------------------------------------
// Log a service (Quick Service and the full form)
// ---------------------------------------------------------------------------
export async function createService(_prev: ServiceActionState, formData: FormData): Promise<ServiceActionState> {
  const sledId = idFrom(formData, "sledId");
  const user = await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId) return { error: "Snowmobile not found." };

  const raw = formValues(formData, FIELDS);
  const parsed = createServiceSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.performedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { performedOn: [dateError] }, values: raw };

  const sled = await getSled(sledId, user.id);
  if (!sled) return { error: "Snowmobile not found." };
  const { usable, names } = await usableTasks(sled);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_maintenance_entry", {
    p_idempotency_key: input.idempotencyKey,
    p_sled_id: sledId,
    p_performed_on: input.performedOn,
    p_title: input.title,
    p_category: input.category,
    p_done_by: input.doneBy,
    p_notes: input.notes,
    p_labor_cost: input.laborCost,
    p_other_cost: input.otherCost,
    p_reading: serviceReading(input) ?? undefined,
    p_tasks: tasksForDatabase(input.tasks, usable, names),
    p_parts: partsForDatabase(input.parts),
  });
  if (error || !data) {
    const message = sledErrorMessage(error, "service record");
    return { error: message, fieldErrors: fieldFor(message), values: raw };
  }

  refresh();
  const entryId = (data as { entry_id?: string }).entry_id;
  return { ok: true, entryId, savedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Edit a service record
// ---------------------------------------------------------------------------
export async function updateService(_prev: ServiceActionState, formData: FormData): Promise<ServiceActionState> {
  const sledId = idFrom(formData, "sledId");
  const entryId = idFrom(formData, "entryId");
  const user = await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  if (!sledId || !entryId) return { error: "Service record not found." };

  const raw = formValues(formData, FIELDS);
  const parsed = updateServiceSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  const input = parsed.data;
  const dateError = futureDateError(input.performedOn, formData.get("timeZone"));
  if (dateError) return { fieldErrors: { performedOn: [dateError] }, values: raw };

  const sled = await getSled(sledId, user.id);
  if (!sled) return { error: "Snowmobile not found." };
  const { usable, names } = await usableTasks(sled);

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_maintenance_entry", {
    p_entry_id: entryId,
    p_version: input.version,
    p_performed_on: input.performedOn,
    p_title: input.title,
    p_category: input.category,
    p_done_by: input.doneBy,
    p_notes: input.notes,
    p_labor_cost: input.laborCost,
    p_other_cost: input.otherCost,
    p_reading: serviceReading(input) ?? undefined,
    p_tasks: tasksForDatabase(input.tasks, usable, names),
    p_parts: partsForDatabase(input.parts),
  });
  if (error) {
    const message = sledErrorMessage(error, "service record");
    return { error: message, fieldErrors: fieldFor(message), values: raw };
  }

  // Decision G: correct a check's outcome. Only items that already are checks
  // can change, and only between Good and Needs Replacement. It is an ordinary
  // update of the item (the record's permissions, guards and audit log apply),
  // so the board recalculates Needs Replacement from the corrected check.
  for (const outcome of ["good", "needs_replacement"] as const) {
    const ids = input.tasks.flatMap((t) => (t.id && t.outcome === outcome ? [t.id] : []));
    if (!ids.length) continue;
    const { error: outcomeError } = await supabase
      .from("maintenance_entry_tasks")
      .update({ outcome })
      .eq("entry_id", entryId)
      .in("id", ids)
      .is("deleted_at", null)
      .not("outcome", "is", null)
      .neq("outcome", outcome);
    if (outcomeError) {
      return {
        error: `The record was saved, but a check result couldn't be changed: ${sledErrorMessage(outcomeError, "service record")} Reload and try again.`,
        values: raw,
      };
    }
  }
  return { ok: true, entryId, savedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Delete a service record (soft delete; owners and editors)
// ---------------------------------------------------------------------------
export async function deleteService(_prev: ServiceActionState, formData: FormData): Promise<ServiceActionState> {
  const sledId = idFrom(formData, "sledId");
  const entryId = idFrom(formData, "entryId");
  await signedInUser(sledId ? `/garage/${sledId}` : "/garage");
  const version = Number(formData.get("version"));
  if (!sledId || !entryId || !Number.isInteger(version)) return { error: "Service record not found." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_entries")
    .update({ deleted_at: new Date().toISOString(), version })
    .eq("id", entryId)
    .eq("sled_id", sledId)
    .select("id")
    .maybeSingle();
  if (error || !data) return { error: sledErrorMessage(error ?? { code: "42501" }, "service record") };

  refresh();
  return { ok: true, savedAt: Date.now() };
}
